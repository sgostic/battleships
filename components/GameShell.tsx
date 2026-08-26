'use client';

/**
 * Everything that happens on screen during a match.
 *
 * The shell owns the 3D scene and the HUD, and drives both from a stream of
 * authoritative snapshots handed over by a `MatchAdapter`. Snapshots are not
 * rendered the moment they arrive: their events are animated first, then the
 * snapshot is committed. That keeps the panels from spoiling a shell that is
 * still in the air, and it is what lets online and solo play share one shell.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Btn } from '@/components/hud/Btn';
import { DeployBar, FireBar, TargetReadout } from '@/components/hud/Controls';
import { FleetPanel } from '@/components/hud/FleetPanel';
import {
  ErrorToast,
  FatalOverlay,
  OverOverlay,
  StandbyOverlay,
  WaitingOverlay,
} from '@/components/hud/Overlays';
import { ShotLog } from '@/components/hud/ShotLog';
import { TopBar } from '@/components/hud/TopBar';
import type { MatchAdapter } from '@/lib/game/adapter';
import { LOG_LIMIT, type LogEntry, type LogTag } from '@/lib/game/log';
import type { MatchEvent, MatchView } from '@/lib/game/match';
import { SHIP_DEFS, type Orient, type Placement, type ShipKey, cellName, cellsFor, defFor, randomFleet } from '@/lib/game/rules';
import { type BoardSide, type SceneOptions, type ScenePhase, SeaBattleScene, createScene } from '@/lib/game/scene';

export type GameShellProps = {
  adapter: MatchAdapter;
  /** Room-level failure (missing, full, expired) that no in-scene UI can fix. */
  fatal?: string | null;
  inviteUrl?: string;
  onLeave?: () => void;
};

export function GameShell({ adapter, fatal = null, inviteUrl, onLeave }: GameShellProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<SeaBattleScene | null>(null);

  const [glFatal, setGlFatal] = useState<string | null>(null);
  const [display, setDisplay] = useState<MatchView | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [draft, setDraft] = useState<Placement[]>([]);
  const [selKey, setSelKey] = useState<ShipKey | null>(SHIP_DEFS[0].key);
  const [orient, setOrient] = useState<Orient>('H');
  const [hover, setHover] = useState<number | null>(null);
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const appliedRef = useRef(-1);
  const pendingRef = useRef<MatchView | null>(null);
  const drainingRef = useRef(false);
  const initedRef = useRef(false);
  const logIdRef = useRef(0);
  /** Always points at the current render's pick handler. */
  const pickRef = useRef<(idx: number) => void>(() => {});

  const pushLog = useCallback((tag: LogTag, text: string) => {
    logIdRef.current += 1;
    const entry: LogEntry = { id: logIdRef.current, tag, text };
    setLog((prev) => [entry, ...prev].slice(0, LOG_LIMIT));
  }, []);

  /* ------------------------------------------------------------------ scene ---- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const opts: SceneOptions = {
      canvas,
      onHover: (idx) => setHover(idx),
      onPick: (idx) => pickRef.current(idx),
      onFatal: (message) => setGlFatal(message),
    };
    const scene = createScene(opts);
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

  const applySnapshot = useCallback((view: MatchView) => {
    appliedRef.current = view.eventSeq;
    const scene = sceneRef.current;
    setDraft(view.you.fleet ?? []);
    setSelKey(view.you.fleet ? null : SHIP_DEFS[0].key);
    if (!scene) return;

    scene.reset();
    if (view.you.fleet) scene.setMyFleet(view.you.fleet);
    scene.syncBoard('mine', view.you.board);
    scene.syncBoard('enemy', view.them.board);
    view.them.revealed.forEach((p) => scene.revealSunkSilently('enemy', p));

    if (view.you.fleet) {
      const sunk = new Set(view.you.ships.filter((s) => s.sunk).map((s) => s.key));
      view.you.fleet
        .filter((p) => sunk.has(p.key))
        .forEach((p) => scene.revealSunkSilently('mine', p));
    }
  }, []);

  const applyEvent = useCallback(
    async (event: MatchEvent, view: MatchView) => {
      const scene = sceneRef.current;
      const you = view.you.side;

      switch (event.type) {
        case 'joined':
          if (event.side !== you) pushLog('CMD', `${event.name} entered the theater`);
          break;
        case 'deployed':
          pushLog('RDY', event.side === you ? 'Your fleet is set' : 'Enemy fleet is set');
          break;
        case 'battle':
          pushLog('CMD', 'Battle stations.');
          break;
        case 'shot': {
          const mine = event.by === you;
          const target: BoardSide = mine ? 'enemy' : 'mine';
          await scene?.playShot({
            target,
            idx: event.idx,
            hit: event.hit,
            sunk: event.sunk,
          });
          const who = mine ? 'You' : 'Enemy';
          if (event.sunk) pushLog('SNK', `${who} sank the ${event.sunk.name}`);
          else if (event.hit) pushLog('HIT', `${who} hit at ${cellName(event.idx)}`);
          else pushLog('MIS', `${who} missed at ${cellName(event.idx)}`);
          break;
        }
        case 'over':
          if (event.winner === you) {
            // A walkout also ends the match, so do not claim a kill we did not make.
            pushLog('CMD', view.them.present ? 'Enemy fleet destroyed' : 'Opponent forfeited');
          } else {
            pushLog('CMD', 'Your fleet is lost');
          }
          break;
        case 'left':
          if (event.side !== you) pushLog('ERR', 'Opponent left the theater');
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
    [pushLog],
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
          if (!view.you.fleet) pushLog('RDY', 'Place your fleet. Drag to orbit.');
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
      }
    } finally {
      drainingRef.current = false;
      setBusy(false);
    }
  }, [applyEvent, applySnapshot, pushLog]);

  useEffect(() => {
    if (!adapter.view) return;
    pendingRef.current = adapter.view;
    void drain();
  }, [adapter.view, drain]);

  /* ------------------------------------------------------------ scene inputs ---- */

  const deploying = Boolean(display && !display.you.ready && display.phase !== 'over');
  const battling = display?.phase === 'battle';
  const myTurn = battling && display?.turn === 'you';

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !display) return;
    const phase: ScenePhase =
      display.phase === 'battle' ? 'battle' : display.phase === 'over' ? 'over' : 'deploy';
    const interactive = !busy && (deploying || Boolean(myTurn));
    scene.setPhase(phase, interactive);
  }, [display, busy, deploying, myTurn]);

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
    (idx: number) => {
      const scene = sceneRef.current;
      if (!scene || !display || busy) return;

      if (deploying) {
        if (!selKey) return;
        const def = defFor(selKey);
        if (!def) return;
        const cells = cellsFor(idx, def.len, orient);
        const taken = new Set(draft.flatMap((p) => p.cells));
        if (!cells || cells.some((c) => taken.has(c))) return;

        const placement: Placement = { key: selKey, orient, cells };
        const next = [...draft.filter((p) => p.key !== selKey), placement];
        scene.click();
        scene.setMyFleet([placement]);
        setDraft(next);
        pushLog('POS', `${def.name} set at ${cellName(cells[0])}`);
        const remaining = SHIP_DEFS.map((d) => d.key).filter((k) => !next.some((p) => p.key === k));
        setSelKey(remaining[0] ?? null);
        return;
      }

      if (myTurn) void adapter.fire(idx);
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
        const idx = sceneRef.current?.hoverIndex() ?? -1;
        if (idx >= 0) {
          e.preventDefault();
          pickRef.current(idx);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ---------------------------------------------------------------- controls ---- */

  const selectShip = useCallback(
    (key: ShipKey) => {
      const scene = sceneRef.current;
      setDraft((prev) => prev.filter((p) => p.key !== key));
      scene?.clearShip('mine', key);
      setSelKey(key);
    },
    [],
  );

  const randomise = useCallback(() => {
    const scene = sceneRef.current;
    const fleet = randomFleet();
    scene?.clearFleet('mine');
    scene?.setMyFleet(fleet);
    scene?.click();
    setDraft(fleet);
    setSelKey(null);
    pushLog('POS', 'Fleet deployed at random');
  }, [pushLog]);

  const clearFleet = useCallback(() => {
    sceneRef.current?.clearFleet('mine');
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
    const idx = sceneRef.current?.hoverIndex() ?? -1;
    if (idx >= 0) pickRef.current(idx);
  }, []);

  /* -------------------------------------------------------------------- copy ---- */

  const placedKeys = draft.map((p) => p.key);
  const allPlaced = draft.length === SHIP_DEFS.length;
  const selName = selKey ? defFor(selKey)?.name.toUpperCase() : null;

  const turnLabel = (() => {
    if (!display) return 'CONNECTING';
    if (display.phase === 'over') return display.outcome === 'win' ? 'VICTORY' : 'DEFEAT';
    if (display.phase === 'battle') return display.turn === 'you' ? 'YOUR TURN' : 'ENEMY TURN';
    if (display.phase === 'lobby') return 'AWAITING FOE';
    return display.you.ready ? 'STANDBY' : 'DEPLOYMENT';
  })();

  const phaseLabel = (() => {
    if (!display) return 'LINK UP';
    if (display.phase === 'battle') return 'PHASE II';
    if (display.phase === 'over') return 'ENGAGEMENT CLOSED';
    return 'PHASE I';
  })();

  const deployHint = (() => {
    if (!display) return 'Establishing link…';
    if (display.phase === 'lobby' && allPlaced) return 'FLEET READY · WAITING FOR AN OPPONENT';
    if (selName) return `PLACING ${selName}  ·  ${orient === 'H' ? 'HORIZONTAL' : 'VERTICAL'}`;
    return allPlaced ? 'FLEET READY' : 'SELECT A SHIP FROM YOUR ROSTER';
  })();

  const roomFatal = fatal ?? glFatal;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-abyss select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block size-full touch-none" />

      <div className="pointer-events-none absolute inset-0">
        <TopBar
          turnLabel={turnLabel}
          phaseLabel={phaseLabel}
          urgent={battling && display?.turn === 'them'}
          muted={muted}
          onToggleMute={() => setMuted((m) => !m)}
          roomCode={adapter.mode === 'online' ? adapter.roomId : null}
          opponent={display?.them.name ?? null}
          onCopyInvite={inviteUrl ? copyInvite : undefined}
          copied={copied}
          onLeave={onLeave}
        />

        {display ? (
          <>
            <div
              className={`absolute top-[104px] left-5 hidden lg:block ${deploying ? 'pointer-events-auto' : ''}`}
            >
              <FleetPanel
                title="Your fleet"
                ships={display.you.ships}
                mine
                deploying={deploying}
                selected={selKey}
                placed={placedKeys}
                onSelect={deploying ? selectShip : undefined}
              />
            </div>

            <div className="absolute top-[104px] right-5 hidden lg:block">
              <FleetPanel
                title="Enemy fleet"
                ships={display.them.ships}
                mine={false}
                deploying={false}
                align="right"
              />
            </div>

            <div className="absolute bottom-5 left-5 hidden sm:block">
              <ShotLog entries={log} />
            </div>

            <div className="hidden sm:block">
              <TargetReadout
                label={hover == null ? '——' : cellName(hover)}
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

            {display.phase === 'deploy' && display.you.ready ? (
              <StandbyOverlay message="Awaiting enemy deployment" />
            ) : null}

            {battling && display.turn === 'them' && !busy ? (
              <StandbyOverlay message="Enemy is taking aim" />
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

        {display?.phase === 'lobby' && adapter.mode === 'online' && adapter.roomId && inviteUrl ? (
          <WaitingOverlay
            roomCode={adapter.roomId}
            inviteUrl={inviteUrl}
            onCopy={copyInvite}
            copied={copied}
          />
        ) : null}

        {display?.phase === 'over' && display.outcome ? (
          <OverOverlay
            outcome={display.outcome}
            shots={display.you.shotsFired}
            hits={display.you.hitsLanded}
            onRematch={() => void adapter.rematch()}
            rematchPending={display.you.rematch}
            opponentWantsRematch={display.them.rematch}
            opponentPresent={display.them.present}
            soloMode={adapter.mode === 'solo'}
          />
        ) : null}

        {roomFatal ? <FatalOverlay message={roomFatal} /> : null}

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
