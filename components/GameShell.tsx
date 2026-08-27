'use client';

/**
 * Everything that happens on screen during a match.
 *
 * The shell owns the 3D scene and the HUD, and drives both from a stream of
 * authoritative snapshots handed over by a `MatchAdapter`. Snapshots are not
 * rendered the moment they arrive: their events are animated first, then the
 * snapshot is committed. That keeps the panels from spoiling a shell that is
 * still in the air, and it is what lets online (duel or duo) and solo play
 * share one shell.
 *
 * The match machine speaks in seats (`Side`); the 3D theater speaks in
 * viewer-relative slots (`you` / `ally` / `foeA` / `foeB`). This file is the
 * only place that translates between the two.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Btn } from '@/components/hud/Btn';
import { DeployBar, FireBar, TargetReadout } from '@/components/hud/Controls';
import { FleetPanel } from '@/components/hud/FleetPanel';
import {
  ErrorToast,
  FatalOverlay,
  LobbyOverlay,
  OverOverlay,
  SpecialMoveOverlay,
  StandbyOverlay,
  WaitingOverlay,
} from '@/components/hud/Overlays';
import { Chat } from '@/components/hud/Chat';
import { TacticalActions } from '@/components/hud/TacticalActions';
import { type TurnChip, TopBar } from '@/components/hud/TopBar';
import type { MatchAdapter } from '@/lib/game/adapter';
import { LOG_LIMIT, type LogEntry, type LogTag } from '@/lib/game/log';
import type { MatchEvent, MatchView, SeatView, Side, SpecialKind, Team } from '@/lib/game/match';
import { SHIP_DEFS, type Orient, type Placement, type ShipKey, cellName, cellsFor, defFor, randomFleet } from '@/lib/game/rules';
import {
  type BoardHit,
  type ScenePhase,
  type Slot,
  type SlotSpec,
  SeaBattleScene,
  createScene,
} from '@/lib/game/scene';

export type GameShellProps = {
  adapter: MatchAdapter;
  /** Room-level failure (missing, full, expired) that no in-scene UI can fix. */
  fatal?: string | null;
  inviteUrl?: string;
  onLeave?: () => void;
  onNicknameSubmit?: (name: string) => void;
};

/* ------------------------------------------------------------ slot mapping ---- */

type SlotAssignment = { slot: Slot; seat: SeatView };

/** Maps the match's absolute seats onto the theater's viewer-relative slots. */
function assignSlots(view: MatchView): SlotAssignment[] {
  // Spectators have no friendly board. Keep every board fogged, but still map
  // the full battlefield into the fixed scene slots so 2v2 remains watchable.
  if (view.spectating) {
    const slots: Slot[] = view.mode === 'duo' ? ['you', 'ally', 'foeA', 'foeB'] : ['you', 'foeA'];
    return view.seats.map((seat, index) => ({ slot: slots[index], seat }));
  }
  const out: SlotAssignment[] = [];
  view.seats.forEach((seat) => {
    if (seat.relation === 'self') out.push({ slot: 'you', seat });
    else if (seat.relation === 'ally') out.push({ slot: 'ally', seat });
  });
  let foeIdx = 0;
  view.seats.forEach((seat) => {
    if (seat.relation === 'foe') {
      out.push({ slot: foeIdx === 0 ? 'foeA' : 'foeB', seat });
      foeIdx += 1;
    }
  });
  return out;
}

function slotForSide(view: MatchView, side: Side): Slot | null {
  return assignSlots(view).find((a) => a.seat.side === side)?.slot ?? null;
}

function sideForSlot(view: MatchView, slot: Slot): Side | null {
  return assignSlots(view).find((a) => a.slot === slot)?.seat.side ?? null;
}

function seatSpec(seat: SeatView, slot: Slot): SlotSpec {
  return {
    slot,
    name: seat.name ?? 'Commander',
    team: seat.team,
    relation: seat.relation,
    fogged: seat.relation === 'foe',
    eliminated: seat.eliminated,
  };
}

export function GameShell({ adapter, fatal = null, inviteUrl, onLeave, onNicknameSubmit }: GameShellProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SeaBattleScene | null>(null);

  const [glFatal, setGlFatal] = useState<string | null>(null);
  const [display, setDisplay] = useState<MatchView | null>(null);
  const [, setLog] = useState<LogEntry[]>([]);
  const [draft, setDraft] = useState<Placement[]>([]);
  const [selKey, setSelKey] = useState<ShipKey | null>(SHIP_DEFS[0].key);
  const [orient, setOrient] = useState<Orient>('H');
  const [hover, setHover] = useState<BoardHit | null>(null);
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [turnAlert, setTurnAlert] = useState(false);
  const [specialCallout, setSpecialCallout] = useState<{ name: string; action: string } | null>(null);
  const [specialModal, setSpecialModal] = useState<{ kind: SpecialKind; turnStartedAt: number } | null>(null);
  const previousTurnRef = useRef<Side | null>(null);
  const previousTurnStartedAtRef = useRef<number | null>(null);

  const appliedRef = useRef(-1);
  const adapterRef = useRef(adapter);
  useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);
  const pendingRef = useRef<MatchView | null>(null);
  const drainingRef = useRef(false);
  const initedRef = useRef(false);
  const logIdRef = useRef(0);
  /** Always points at the current render's pick handler. */
  const pickRef = useRef<(hit: BoardHit) => void>(() => {});

  const pushLog = useCallback((tag: LogTag, text: string) => {
    logIdRef.current += 1;
    const entry: LogEntry = { id: logIdRef.current, tag, text };
    setLog((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
  }, []);

  const announceSpecial = useCallback(async (name: string, action: string) => {
    setSpecialCallout({ name, action });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_650));
    setSpecialCallout(null);
  }, []);

  /* ------------------------------------------------------------------ scene ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = createScene({
      canvas,
      onHover: (hit) => setHover(hit),
      onPick: (hit) => pickRef.current(hit),
      onFatal: (message) => setGlFatal(message),
    });
    sceneRef.current = scene;

    return () => {
      scene?.dispose();
      sceneRef.current = null;
      initedRef.current = false;
      appliedRef.current = -1;
    };
  }, []);

  useEffect(() => {
    document.body.dataset.theater = 'on';
    return () => {
      delete document.body.dataset.theater;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setMuted(muted);
  }, [muted]);

  /* ---------------------------------------------------- snapshots and events ---- */

  const syncSceneRoster = useCallback((view: MatchView, reset = false) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const assignments = assignSlots(view);
    scene.setRoster(assignments.map(({ slot, seat }) => seatSpec(seat, slot)));
    if (reset) scene.reset();
    assignments.forEach(({ slot, seat }) => {
      if (seat.fleet) scene.setFleet(slot, seat.fleet);
      scene.syncBoard(slot, seat.board);
      seat.revealed.forEach((p) => scene.revealSunkSilently(slot, p));
      if (seat.eliminated) scene.markEliminated(slot);
    });
  }, []);

  const applySnapshot = useCallback((view: MatchView) => {
    appliedRef.current = view.eventSeq;
    const self = view.seats.find((s) => s.relation === 'self') ?? null;
    setDraft(self?.fleet ?? []);
    setSelKey(self?.fleet ? null : SHIP_DEFS[0].key);
    syncSceneRoster(view, true);
  }, [syncSceneRoster]);

  const applyEvent = useCallback(
    async (event: MatchEvent, view: MatchView) => {
      const scene = sceneRef.current;
      const you = view.you;
      const nameOf = (side: Side) => view.seats.find((s) => s.side === side)?.name ?? 'Commander';

      switch (event.type) {
        case 'joined':
          if (event.side !== you) pushLog('CMD', `${event.name} entered the theater`);
          break;
        case 'team':
          if (event.side !== you) {
            const label = event.team === 'red' ? 'Team Red' : event.team === 'blue' ? 'Team Blue' : 'no team';
            pushLog('CMD', `${nameOf(event.side)} joined ${label}`);
          }
          break;
        case 'ready':
          break;
        case 'deploying':
          pushLog('CMD', 'All hands aboard. Deploy your fleet.');
          break;
        case 'deployed':
          pushLog('RDY', event.side === you ? 'Your fleet is set' : `${nameOf(event.side)}'s fleet is set`);
          break;
        case 'battle':
          pushLog('CMD', 'Battle stations.');
          break;
        case 'special-strike':
          {
            await announceSpecial(nameOf(event.by), 'SCORCHED EARTH');
            const fromSlot = slotForSide(view, event.by);
            const allySlot = slotForSide(view, event.ally);
            const targetSlot = slotForSide(view, event.target);
            const ally = view.seats.find((seat) => seat.side === event.ally);
            if (fromSlot && allySlot && ally) {
              await scene?.playSpecialBombardment({ from: fromSlot, to: allySlot, cells: event.bombed, marks: ally.board });
            }
            if (targetSlot) {
              for (const ship of event.destroyed) {
                await scene?.playSpecialExplosion(targetSlot, ship);
                await scene?.playSpecialSinks(targetSlot, [ship]);
              }
            }
          }
          pushLog('SNK', `${nameOf(event.by)} launched a scorched-earth strike on ${nameOf(event.target)}`);
          break;
        case 'special-mark': {
          await announceSpecial(nameOf(event.by), 'TRAITOR\'S MARK');
          const fromSlot = slotForSide(view, event.by);
          const targetSlot = slotForSide(view, event.target);
          const allySlot = slotForSide(view, event.ally);
          if (fromSlot && targetSlot) {
            await scene?.playShot({ from: fromSlot, to: targetSlot, idx: event.idx, hit: true, sunk: event.sunk });
          }
          if (allySlot) {
            await scene?.playSpecialExplosion(allySlot, event.allySunk);
            await scene?.playSpecialSinks(allySlot, [event.allySunk]);
          }
          pushLog('HIT', `${nameOf(event.by)} marked ${nameOf(event.target)} at ${cellName(event.idx)} — ${nameOf(event.ally)} lost a ship`);
          break;
        }
        case 'special-salvo':
          await announceSpecial(nameOf(event.by), 'RAPID SALVO');
          pushLog('CMD', `${nameOf(event.by)} claimed two shots; ${nameOf(event.ally)} will lose three turns`);
          break;
        case 'special-bastion':
          await announceSpecial(nameOf(event.by), 'ALLIED BASTION');
          pushLog('CMD', `${nameOf(event.by)} is shielded for ${event.turns} enemy turns; fire is redirected to ${nameOf(event.ally)}`);
          break;
        case 'skipped':
          pushLog('CMD', `${nameOf(event.side)}'s turn was skipped (${event.remaining} remaining)`);
          break;
        case 'shot': {
          const fromSlot = slotForSide(view, event.by);
          const toSlot = slotForSide(view, event.at);
          if (fromSlot && toSlot) {
            await scene?.playShot({
              from: fromSlot,
              to: toSlot,
              idx: event.idx,
              hit: event.hit,
              sunk: event.sunk,
            });
          }
          const who = event.by === you ? 'You' : nameOf(event.by);
          const target = event.at === you ? 'you' : nameOf(event.at);
          if (event.sunk) {
            pushLog('SNK', `${who} sank ${target === 'you' ? 'your' : `${target}'s`} ${event.sunk.name}`);
          } else if (event.hit) {
            pushLog('HIT', `${who} hit ${target} at ${cellName(event.idx)}`);
          } else {
            pushLog('MIS', `${who} missed ${target} at ${cellName(event.idx)}`);
          }
          break;
        }
        case 'eliminated': {
          const slot = slotForSide(view, event.side);
          if (slot) scene?.markEliminated(slot);
          pushLog('ELM', event.side === you ? 'Your fleet is destroyed' : `${nameOf(event.side)}'s fleet is destroyed`);
          break;
        }
        case 'over':
          pushLog('CMD', view.outcome === 'win' ? 'Victory' : 'Defeat');
          break;
        case 'left':
          if (event.side !== you) pushLog('ERR', 'A commander left the theater');
          break;
        case 'reset':
          scene?.reset();
          setLog([]);
          setDraft([]);
          setSelKey(SHIP_DEFS[0].key);
          pushLog('RDY', 'New engagement. Place your fleet.');
          break;
      }
    },
    [announceSpecial, pushLog],
  );

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (pendingRef.current) {
        const view = pendingRef.current;
        pendingRef.current = null;

        if (!initedRef.current) {
          applySnapshot(view);
          initedRef.current = true;
          setDisplay(view);
          const self = view.seats.find((s) => s.relation === 'self');
          if (view.spectating) pushLog('CMD', 'Spectating the engagement.');
          else if (!self?.fleet) pushLog('RDY', 'Place your fleet. Drag to orbit.');
          continue;
        }

        const events = view.events
          .filter((e) => e.seq > appliedRef.current)
          .sort((a, b) => a.seq - b.seq);

        if (events.length) setBusy(true);
        for (const event of events) {
          await applyEvent(event, view);
          appliedRef.current = event.seq;
        }
        setBusy(false);
        setDisplay(view);
        // The roster can grow after the initial snapshot (notably when the
        // second teammate joins). Keep the theater in step with the view.
        syncSceneRoster(view);
      }
    } finally {
      drainingRef.current = false;
      setBusy(false);
    }
  }, [applyEvent, applySnapshot, pushLog, syncSceneRoster]);

  useEffect(() => {
    if (!adapter.view) return;
    pendingRef.current = adapter.view;
    void drain();
  }, [adapter.view, drain]);

  /* ------------------------------------------------------------ derived state ---- */

  const yourSeat = display?.seats.find((s) => s.relation === 'self') ?? null;
  const allySeat = display?.seats.find((s) => s.relation === 'ally') ?? null;
  const foeSeats = useMemo(() => display?.seats.filter((s) => s.relation === 'foe') ?? [], [display]);

  const deploying = Boolean(display && yourSeat && !yourSeat.deployed && display.phase !== 'over');
  const battling = display?.phase === 'battle';
  const myTurn = battling && display?.turn === display?.you;
  // `display` intentionally waits for scene animation; use the latest adapter
  // snapshot for actions so a completed opponent move cannot leave a stale button live.
  const authoritativeMyTurn = adapter.view?.phase === 'battle' && adapter.view.turn === adapter.view.you;
  const canUseSpecial = useCallback((kind: SpecialKind) => {
    if (!display || !authoritativeMyTurn || !display.specials[kind] || !allySeat || allySeat.eliminated) return false;
    if (kind === 'scorched-earth') return foeSeats.some((foe) => !foe.eliminated && foe.ships.filter((ship) => !ship.sunk).length >= 2);
    if (kind === 'rapid-salvo' || kind === 'allied-bastion') return true;
    return allySeat.ships.some((ship) => !ship.sunk) && foeSeats.some((foe) => !foe.eliminated && foe.ships.some((ship) => !ship.sunk));
  }, [allySeat, authoritativeMyTurn, display, foeSeats]);
  const openSpecial = useCallback((kind: SpecialKind) => {
    const live = adapterRef.current.view;
    // Recheck in the click handler: the displayed snapshot can be temporarily
    // behind while the previous shell animation is still finishing.
    if (!live || live.phase !== 'battle' || live.turn !== live.you || !live.specials[kind]) return;
    setSpecialModal({ kind, turnStartedAt: live.turnStartedAt ?? 0 });
  }, []);
  const specialModalOpen = Boolean(authoritativeMyTurn && myTurn && display?.turnStartedAt !== null && specialModal?.turnStartedAt === display.turnStartedAt);

  // Online snapshots and the Three.js scene initialize independently. Syncing
  // from the committed display guarantees that a teammate who joins after the
  // first snapshot gets a board even if the initial scene sync ran too early.
  useEffect(() => {
    if (display) syncSceneRoster(display);
  }, [display, syncSceneRoster]);

  useEffect(() => {
    if (!myTurn || specialModalOpen || adapter.mode !== 'solo' || !display) return;
    const turnStartedAt = display.turnStartedAt;
    const timer = window.setTimeout(() => {
      const latest = adapterRef.current.view;
      if (!latest || latest.phase !== 'battle' || latest.turn !== latest.you || latest.turnStartedAt !== turnStartedAt) return;
      const targets = latest.seats.filter((seat) => (
        seat.relation === 'foe' && !seat.eliminated && (!latest.forcedTarget || seat.side === latest.forcedTarget)
      ));
      const choices = targets.flatMap((seat) => seat.board.flatMap((mark, idx) => (mark === 0 ? [{ side: seat.side, idx }] : [])));
      const choice = choices[Math.floor(Math.random() * choices.length)];
      if (choice) void adapterRef.current.fire(choice.side, choice.idx);
    }, Math.max(0, (display.turnStartedAt ?? Date.now()) + 20_000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [adapter.mode, display, myTurn, specialModalOpen]);
  useEffect(() => {
    const currentTurn = display?.phase === 'battle' ? display.turn : null;
    const turnStartedAt = display?.phase === 'battle' ? display.turnStartedAt : null;
    const becameMyTurn = currentTurn === display?.you && (
      previousTurnRef.current !== currentTurn || previousTurnStartedAtRef.current !== turnStartedAt
    );
    previousTurnRef.current = currentTurn;
    previousTurnStartedAtRef.current = turnStartedAt;
    if (!becameMyTurn) return;
    setTurnAlert(true);
    const timer = window.setTimeout(() => setTurnAlert(false), 1800);
    return () => window.clearTimeout(timer);
  }, [display?.phase, display?.turn, display?.turnStartedAt, display?.you]);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!myTurn) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [myTurn]);
  const shotSeconds = myTurn && display?.turnStartedAt !== null
    ? Math.max(0, Math.ceil((display!.turnStartedAt! + 20_000 - now) / 1000))
    : null;

  const livingFoeSlots = useMemo(() => {
    if (!display) return [];
    return assignSlots(display)
      .filter((a) => (
        (a.slot === 'foeA' || a.slot === 'foeB') &&
        !a.seat.eliminated &&
        (!display.forcedTarget || a.seat.side === display.forcedTarget)
      ))
      .map((a) => a.slot);
  }, [display]);

  /* ------------------------------------------------------------ scene inputs ---- */

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !display) return;
    const phase: ScenePhase =
      display.phase === 'battle' ? 'battle' : display.phase === 'over' ? 'over' : 'deploy';
    const interactive = !busy && !specialModalOpen && (deploying || Boolean(myTurn));
    scene.setPhase(phase, interactive);

    if (deploying) scene.setPickable(['you']);
    else if (myTurn && !specialModalOpen) scene.setPickable(livingFoeSlots);
    else scene.setPickable([]);

    const actingSlot = display.phase === 'battle' && display.turn ? slotForSide(display, display.turn) : null;
    scene.setActingSlot(actingSlot);
  }, [display, busy, deploying, myTurn, livingFoeSlots, specialModalOpen]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (!deploying || !selKey) {
      scene.setGhost(null);
      return;
    }
    scene.setGhost({ key: selKey, orient, occupied: draft.flatMap((p) => p.cells) });
  }, [deploying, selKey, orient, draft]);

  const handlePick = useCallback(
    (hit: BoardHit) => {
      const scene = sceneRef.current;
      if (!scene || !display || busy) return;

      if (deploying) {
        if (hit.slot !== 'you' || !selKey) return;
        const def = defFor(selKey);
        if (!def) return;
        const cells = cellsFor(hit.idx, def.len, orient);
        const taken = new Set(draft.flatMap((p) => p.cells));
        if (!cells || cells.some((c) => taken.has(c))) return;

        const placement: Placement = { key: selKey, orient, cells };
        const next = [...draft.filter((p) => p.key !== selKey), placement];
        scene.click();
        scene.setFleet('you', [placement]);
        setDraft(next);
        pushLog('POS', `${def.name} set at ${cellName(cells[0])}`);
        const remaining = SHIP_DEFS.map((d) => d.key).filter((k) => !next.some((p) => p.key === k));
        setSelKey(remaining[0] ?? null);
        return;
      }

      if (myTurn) {
        const side = sideForSlot(display, hit.slot);
        if (side) void adapter.fire(side, hit.idx);
      }
    },
    [adapter, busy, deploying, display, draft, myTurn, orient, pushLog, selKey],
  );

  // The scene holds one stable callback; this keeps it pointed at the latest closure.
  useEffect(() => {
    pickRef.current = handlePick;
  }, [handlePick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') {
        setOrient((o) => (o === 'H' ? 'V' : 'H'));
      }
      if (e.key === ' ') {
        const hit = sceneRef.current?.hoverTarget() ?? null;
        if (hit) {
          e.preventDefault();
          pickRef.current(hit);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------------------------------------------------------- controls ---- */

  const selectShip = useCallback((key: ShipKey) => {
    const scene = sceneRef.current;
    setDraft((prev) => prev.filter((p) => p.key !== key));
    scene?.clearShip('you', key);
    setSelKey(key);
  }, []);

  const randomise = useCallback(() => {
    const scene = sceneRef.current;
    const fleet = randomFleet();
    scene?.clearFleet('you');
    scene?.setFleet('you', fleet);
    scene?.click();
    setDraft(fleet);
    setSelKey(null);
    pushLog('POS', 'Fleet deployed at random');
  }, [pushLog]);

  const clearFleet = useCallback(() => {
    sceneRef.current?.clearFleet('you');
    setDraft([]);
    setSelKey(SHIP_DEFS[0].key);
  }, []);

  const submitFleet = useCallback(async () => {
    if (draft.length !== SHIP_DEFS.length) return;
    setSubmitting(true);
    try {
      await adapter.deploy(draft);
    } finally {
      setSubmitting(false);
    }
  }, [adapter, draft]);

  const copyInvite = useCallback(() => {
    if (!inviteUrl) return;
    void navigator.clipboard
      .writeText(inviteUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [inviteUrl]);

  const fireAtHover = useCallback(() => {
    const hit = sceneRef.current?.hoverTarget() ?? null;
    if (hit) pickRef.current(hit);
  }, []);

  const joinTeam = useCallback(
    (team: Team) => {
      void adapter.setTeam?.(team);
    },
    [adapter],
  );
  const setLobbyReady = useCallback(
    (ready: boolean) => {
      void adapter.setReady?.(ready);
    },
    [adapter],
  );

  /* -------------------------------------------------------------------- copy ---- */

  const placedKeys = draft.map((p) => p.key);
  const allPlaced = draft.length === SHIP_DEFS.length;
  const selName = selKey ? defFor(selKey)?.name.toUpperCase() : null;

  const turnLabel = (() => {
    if (!display) return 'CONNECTING';
    if (display.spectating) return display.phase === 'over' ? 'ENGAGEMENT CLOSED' : 'SPECTATING';
    if (display.phase === 'over') return display.outcome === 'win' ? 'VICTORY' : 'DEFEAT';
    if (display.phase === 'battle') {
      if (display.turn === display.you) return 'YOUR TURN';
      const actor = display.turn ? display.seats.find((s) => s.side === display.turn)?.name : null;
      return actor ? `${actor.toUpperCase()}'S TURN` : 'ENEMY TURN';
    }
    if (display.phase === 'lobby') return display.mode === 'duo' ? 'LOBBY' : 'AWAITING FOE';
    return yourSeat?.deployed ? 'STANDBY' : 'DEPLOYMENT';
  })();

  const phaseLabel = (() => {
    if (!display) return 'LINK UP';
    if (display.phase === 'battle') return 'PHASE II';
    if (display.phase === 'over') return 'ENGAGEMENT CLOSED';
    return 'PHASE I';
  })();

  const deployHint = (() => {
    if (!display) return 'Establishing link…';
    if (display.phase === 'lobby' && display.mode === 'duel' && allPlaced) {
      return 'FLEET READY · WAITING FOR AN OPPONENT';
    }
    if (selName) return `PLACING ${selName}  ·  ${orient === 'H' ? 'HORIZONTAL' : 'VERTICAL'}`;
    return allPlaced ? 'FLEET READY' : 'SELECT A SHIP FROM YOUR ROSTER';
  })();

  const turnChips: TurnChip[] = display
    ? display.turnOrder.map((side) => {
        const seat = display.seats.find((s) => s.side === side)!;
        return {
          side,
          name: seat.name ?? 'Commander',
          team: seat.team,
          isYou: side === display.you,
          acting: display.turn === side,
          eliminated: seat.eliminated,
        };
      })
    : [];

  const hoverBoardName =
    display && display.mode === 'duo' && hover
      ? assignSlots(display).find((a) => a.slot === hover.slot)?.seat.name ?? null
      : null;

  const roomFatal = fatal ?? glFatal;

  const showLobby = !display?.spectating && display?.phase === 'lobby' && display.mode === 'duo';
  const showWaiting =
    !display?.spectating && display?.phase === 'lobby' && display.mode === 'duel' && adapter.mode === 'online' && Boolean(adapter.roomId) && Boolean(inviteUrl);

  const seatsByTeam: Record<Team, { name: string; ready: boolean; isYou: boolean }[]> = { red: [], blue: [] };
  if (display) {
    display.seats.forEach((s) => {
      if (s.team) {
        seatsByTeam[s.team].push({ name: s.name ?? 'Commander', ready: s.ready, isYou: s.side === display.you });
      }
    });
  }
  const lobbyBlockedReason = (() => {
    if (!display) return null;
    if (!yourSeat?.team) return 'Choose a team first';
    if (seatsByTeam.red.length !== 2 || seatsByTeam.blue.length !== 2) return 'Waiting for the rest of the crew';
    return null;
  })();

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-abyss select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block size-full touch-none" />

      {turnAlert && !specialModalOpen ? (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
          <div className="animate-sb-turn-alert border-y border-brass bg-[rgba(10,44,57,.9)] px-10 py-5 text-center shadow-[0_0_60px_rgba(255,151,63,.4)]">
            <p className="stencil mb-2 text-brass">Battle stations</p>
            <p className="font-display text-4xl font-bold tracking-[0.18em] text-flare sm:text-6xl">YOUR TURN</p>
          </div>
        </div>
      ) : null}

      {specialCallout ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center">
          <div className="animate-sb-special-callout border-y border-flare bg-[rgba(78,30,12,.9)] px-10 py-6 text-center shadow-[0_0_90px_rgba(255,103,39,.62)]">
            <p className="stencil mb-3 text-brass">TACTICAL ACTION DEPLOYED</p>
            <p className="font-display text-3xl font-bold tracking-[0.18em] text-parchment sm:text-5xl">{specialCallout.action}</p>
            <p className="mt-3 font-mono text-[11px] tracking-[0.22em] text-flare">{specialCallout.name.toUpperCase()}</p>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-0">
        <TopBar
          turnLabel={turnLabel}
          phaseLabel={phaseLabel}
          urgent={Boolean(battling && display?.turn !== display?.you)}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          roomCode={adapter.mode === 'online' ? adapter.roomId : null}
          opponent={display && display.mode === 'duel' ? foeSeats[0]?.name ?? null : null}
          onCopyInvite={inviteUrl ? copyInvite : undefined}
          copied={copied}
          onLeave={onLeave}
          turnChips={turnChips}
          shotSeconds={shotSeconds}
        />

        {display ? (
          <>
            <div
              className={`absolute top-[104px] left-5 hidden lg:flex lg:flex-col lg:gap-2 ${deploying ? 'pointer-events-auto' : ''}`}
            >
              <FleetPanel
                title="Your fleet"
                ships={yourSeat?.ships ?? []}
                mine
                deploying={deploying}
                selected={selKey}
                placed={placedKeys}
                onSelect={deploying ? selectShip : undefined}
                team={yourSeat?.team ?? null}
              />
              {allySeat ? (
                <FleetPanel
                  title="Ally fleet"
                  ships={allySeat.ships}
                  mine={false}
                  deploying={false}
                  team={allySeat.team}
                  compact
                />
              ) : null}
            </div>

            <div className="absolute top-[104px] right-5 hidden lg:flex lg:flex-col lg:gap-2">
              {foeSeats.map((seat, i) => (
                <FleetPanel
                  key={seat.side}
                  title={foeSeats.length > 1 ? seat.name ?? `Enemy ${i + 1}` : 'Enemy fleet'}
                  ships={seat.ships}
                  mine={false}
                  deploying={false}
                  align="right"
                  team={seat.team}
                  compact={foeSeats.length > 1}
                />
              ))}
            </div>

            <div className="absolute bottom-5 left-5 hidden sm:block">
              <Chat messages={display.chat} you={display.you} onSend={adapter.sendChat} />
            </div>

            {battling && display.mode === 'duo' && adapter.useSpecialMove ? (
              <TacticalActions
                actions={[
                  {
                    kind: 'scorched-earth', icon: '✹', code: 'ORD-01', name: 'Scorched Earth',
                    detail: 'Destroy 2 enemy ships · bomb 50% of ally grid',
                    available: display.specials['scorched-earth'], active: canUseSpecial('scorched-earth'),
                    onActivate: canUseSpecial('scorched-earth')
                      ? () => openSpecial('scorched-earth')
                      : undefined,
                  },
                  {
                    kind: 'traitors-mark', icon: '◎', code: 'ORD-02', name: 'Traitor’s Mark',
                    detail: 'Reveal a random enemy hit · sink 1 ally ship',
                    available: display.specials['traitors-mark'], active: canUseSpecial('traitors-mark'),
                    onActivate: canUseSpecial('traitors-mark')
                      ? () => openSpecial('traitors-mark')
                      : undefined,
                  },
                  {
                    kind: 'rapid-salvo', icon: '»', code: 'ORD-03', name: 'Rapid Salvo',
                    detail: 'Fire 2 shots · skip ally’s next 3 turns',
                    available: display.specials['rapid-salvo'], active: canUseSpecial('rapid-salvo'),
                    onActivate: canUseSpecial('rapid-salvo')
                      ? () => openSpecial('rapid-salvo')
                      : undefined,
                  },
                  {
                    kind: 'allied-bastion', icon: '◈', code: 'ORD-04', name: 'Allied Bastion',
                    detail: 'Shield yourself · redirect 4 enemy turns to ally',
                    available: display.specials['allied-bastion'], active: canUseSpecial('allied-bastion'),
                    onActivate: canUseSpecial('allied-bastion')
                      ? () => openSpecial('allied-bastion')
                      : undefined,
                  },
                ]}
              />
            ) : null}

            <div className="hidden sm:block">
              <TargetReadout
                label={hover == null ? '——' : cellName(hover.idx)}
                board={hoverBoardName}
                active={hover != null}
              />
            </div>

            {deploying ? (
              <DeployBar
                hint={deployHint}
                canReady={allPlaced && display.phase === 'deploy'}
                submitting={submitting}
                onRotate={() => {
                  sceneRef.current?.click();
                  setOrient((o) => (o === 'H' ? 'V' : 'H'));
                }}
                onRandom={randomise}
                onClear={clearFleet}
                onReady={submitFleet}
              />
            ) : null}

            {myTurn ? (
              <div className="lg:hidden">
                <FireBar onFire={fireAtHover} disabled={busy || hover == null} />
              </div>
            ) : null}

            {display.phase === 'deploy' && yourSeat?.deployed ? (
              <StandbyOverlay message="Awaiting the rest of the crew" />
            ) : null}

            {display.spectating ? <StandbyOverlay message="Spectating — fleet positions are classified" /> : null}

            {battling && display.turn !== display.you && !busy ? (
              <StandbyOverlay message={turnLabel === 'ENEMY TURN' ? 'Enemy is taking aim' : `${turnLabel.replace("'S TURN", '')} is taking aim`} />
            ) : null}
          </>
        ) : null}

        {/* Roster is unreachable on narrow screens, so surface the ship picker inline. */}
        {display && deploying ? (
          <div className="pointer-events-auto absolute top-[92px] left-1/2 flex -translate-x-1/2 flex-wrap justify-center gap-1.5 lg:hidden">
            {SHIP_DEFS.map((def) => {
              const placed = placedKeys.includes(def.key);
              return (
                <Btn
                  key={def.key}
                  onClick={() => selectShip(def.key)}
                  className={[
                    'px-2.5 py-1.5 text-[8.5px]',
                    selKey === def.key ? 'border-brass text-flare' : '',
                    placed ? 'text-parchment/45' : '',
                  ].join(' ')}
                >
                  {placed ? `✓ ${def.name}` : `${def.name} ${def.len}`}
                </Btn>
              );
            })}
          </div>
        ) : null}

        {showWaiting && display ? (
          <WaitingOverlay
            roomCode={adapter.roomId as string}
            inviteUrl={inviteUrl as string}
            onCopy={copyInvite}
            copied={copied}
            onCancel={onLeave ?? (() => {})}
          />
        ) : null}

        {showLobby && display && inviteUrl ? (
          <LobbyOverlay
            roomCode={adapter.roomId ?? display.roomId}
            inviteUrl={inviteUrl}
            onCopy={copyInvite}
            copied={copied}
            yourTeam={yourSeat?.team ?? null}
            yourReady={yourSeat?.ready ?? false}
            seatsByTeam={seatsByTeam}
            canReady={!lobbyBlockedReason}
            reasonBlocked={lobbyBlockedReason}
            onJoinTeam={joinTeam}
            onSetReady={setLobbyReady}
            onCancel={onLeave ?? (() => {})}
          />
        ) : null}

        {specialModalOpen && specialModal && canUseSpecial(specialModal.kind) && adapter.useSpecialMove ? (
          <SpecialMoveOverlay
            kind={specialModal.kind}
            foes={foeSeats}
            onAccept={(target) => {
              const kind = specialModal.kind;
              setSpecialModal(null);
              void adapter.useSpecialMove?.(kind, target);
            }}
            onClose={() => setSpecialModal(null)}
          />
        ) : null}

        {display?.phase === 'over' && display.outcome ? (
          <OverOverlay
            outcome={display.outcome}
            shots={yourSeat?.shotsFired ?? 0}
            hits={yourSeat?.hitsLanded ?? 0}
            onRematch={() => void adapter.rematch()}
            rematchPending={yourSeat?.rematch ?? false}
            others={display.seats
              .filter((s) => s.relation !== 'self')
              .map((s) => ({ name: s.name ?? 'Commander', present: s.present, rematch: s.rematch }))}
            soloMode={adapter.mode === 'solo'}
            ally={allySeat ? { name: allySeat.name ?? 'Ally', shots: allySeat.shotsFired, hits: allySeat.hitsLanded } : null}
          />
        ) : null}

        {roomFatal ? <FatalOverlay message={roomFatal} onNicknameSubmit={onNicknameSubmit} /> : null}

        {adapter.error && !roomFatal ? (
          <ErrorToast message={adapter.error} onDismiss={adapter.clearError} />
        ) : null}

        {!display && !roomFatal ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="stencil animate-sb-pulse text-parchment/60">Establishing link…</p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
