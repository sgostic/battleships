/**
 * The match state machine. Pure and JSON-serializable so the exact same rules run
 * server-side (authoritative, persisted in Redis) and in the browser for solo play.
 *
 * Every mutation appends events. Clients replay events to animate; the redacted
 * snapshot from `viewFor` lets a reconnecting client catch up without spoilers.
 */

import {
  CELLS,
  SHIP_DEFS,
  type Orient,
  type Placement,
  type ShipKey,
  defFor,
  validateFleet,
} from './rules';

export type Side = 'a' | 'b';
export const OTHER: Record<Side, Side> = { a: 'b', b: 'a' };

export type Phase = 'lobby' | 'deploy' | 'battle' | 'over';

/** 0 = never fired at, 1 = miss, 2 = hit. */
export type Mark = 0 | 1 | 2;

export type ShipState = {
  key: ShipKey;
  orient: Orient;
  cells: number[];
  hits: number;
  sunk: boolean;
};

export type PlayerState = {
  /** Secret. Never leaves the server for the opposing player. */
  token: string;
  name: string;
  ships: ShipState[] | null;
  /** Shots the opponent has fired at this player's board, indexed by cell. */
  incoming: Mark[];
  shotsFired: number;
  hitsLanded: number;
  rematch: boolean;
  lastSeen: number;
};

export type SunkReveal = Placement & { name: string };

export type MatchEvent =
  | { seq: number; type: 'joined'; side: Side; name: string }
  | { seq: number; type: 'deployed'; side: Side }
  | { seq: number; type: 'battle'; turn: Side }
  | {
      seq: number;
      type: 'shot';
      by: Side;
      idx: number;
      hit: boolean;
      sunk: SunkReveal | null;
      next: Side | null;
    }
  | { seq: number; type: 'over'; winner: Side }
  | { seq: number; type: 'left'; side: Side }
  | { seq: number; type: 'reset' };

export type MatchRules = { extraShotOnHit: boolean };

export type MatchState = {
  id: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  turn: Side | null;
  winner: Side | null;
  players: { a: PlayerState | null; b: PlayerState | null };
  events: MatchEvent[];
  eventSeq: number;
  rules: MatchRules;
  /** Listed in the quick-match queue. */
  open: boolean;
};

/** Events older than this are dropped; a lagging client resyncs from the snapshot. */
const EVENT_HISTORY = 80;

export type Fail = { ok: false; error: string; code: number };
export type Done<T = undefined> = { ok: true; value: T };
export type Result<T = undefined> = Done<T> | Fail;

const fail = (error: string, code = 400): Fail => ({ ok: false, error, code });
const done = <T,>(value: T): Done<T> => ({ ok: true, value });

export function createMatch(
  id: string,
  now: number,
  rules: MatchRules = { extraShotOnHit: true },
  open = false,
): MatchState {
  return {
    id,
    version: 0,
    createdAt: now,
    updatedAt: now,
    phase: 'lobby',
    turn: null,
    winner: null,
    players: { a: null, b: null },
    events: [],
    eventSeq: 0,
    rules,
    open,
  };
}

/** Omit that distributes over the event union instead of collapsing it. */
type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

function emit(state: MatchState, event: Unsequenced<MatchEvent>): void {
  state.eventSeq += 1;
  state.events.push({ ...event, seq: state.eventSeq } as MatchEvent);
  if (state.events.length > EVENT_HISTORY) {
    state.events.splice(0, state.events.length - EVENT_HISTORY);
  }
}

function touch(state: MatchState, now: number): void {
  state.version += 1;
  state.updatedAt = now;
}

function newPlayer(token: string, name: string, now: number): PlayerState {
  return {
    token,
    name,
    ships: null,
    incoming: new Array<Mark>(CELLS).fill(0),
    shotsFired: 0,
    hitsLanded: 0,
    rematch: false,
    lastSeen: now,
  };
}

export function cleanName(name: unknown, side: Side): string {
  const raw = typeof name === 'string' ? name : '';
  // Strip control characters, then collapse whitespace.
  const safe = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
  return safe || (side === 'a' ? 'Commander A' : 'Commander B');
}

export function sideForToken(state: MatchState, token: string): Side | null {
  if (state.players.a?.token === token) return 'a';
  if (state.players.b?.token === token) return 'b';
  return null;
}

export function seatsTaken(state: MatchState): number {
  return (state.players.a ? 1 : 0) + (state.players.b ? 1 : 0);
}

export function isJoinable(state: MatchState): boolean {
  return seatsTaken(state) < 2 && state.phase === 'lobby';
}

/** Seats a player. Returns the side they were seated on. */
export function join(state: MatchState, token: string, name: string, now: number): Result<Side> {
  const existing = sideForToken(state, token);
  if (existing) {
    state.players[existing]!.lastSeen = now;
    return done(existing);
  }
  if (!isJoinable(state)) return fail('This match is already full', 409);

  const side: Side = state.players.a ? 'b' : 'a';
  state.players[side] = newPlayer(token, cleanName(name, side), now);
  emit(state, { type: 'joined', side, name: state.players[side]!.name });

  if (seatsTaken(state) === 2) {
    state.phase = 'deploy';
    state.open = false;
  }
  touch(state, now);
  return done(side);
}

/** Commits a fleet. Starts the battle once both fleets are in. */
export function deploy(state: MatchState, side: Side, fleet: unknown, now: number): Result {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'deploy') {
    return fail(state.phase === 'lobby' ? 'Waiting for an opponent' : 'Deployment has closed', 409);
  }
  if (player.ships) return fail('Your fleet is already deployed', 409);

  const check = validateFleet(fleet);
  if (!check.ok) return fail(check.error, 422);

  player.ships = check.fleet.map((p) => ({ ...p, hits: 0, sunk: false }));
  emit(state, { type: 'deployed', side });

  if (state.players.a?.ships && state.players.b?.ships) {
    state.phase = 'battle';
    state.turn = 'a';
    emit(state, { type: 'battle', turn: state.turn });
  }
  touch(state, now);
  return done(undefined);
}

/** Resolves a shot. The server is the only place hit/miss is decided. */
export function fire(state: MatchState, side: Side, idx: unknown, now: number): Result {
  const shooter = state.players[side];
  if (!shooter) return fail('You are not seated in this match', 403);
  if (state.phase !== 'battle') return fail('No battle in progress', 409);
  if (state.turn !== side) return fail('Not your turn', 409);
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= CELLS) {
    return fail('Target outside the grid', 422);
  }

  const targetSide = OTHER[side];
  const target = state.players[targetSide];
  if (!target?.ships) return fail('Opponent has not deployed', 409);
  if (target.incoming[idx] !== 0) return fail('You already fired at that cell', 409);

  const ship = target.ships.find((s) => !s.sunk && s.cells.includes(idx));
  const hit = Boolean(ship);
  target.incoming[idx] = hit ? 2 : 1;
  shooter.shotsFired += 1;
  if (hit) shooter.hitsLanded += 1;

  let sunk: SunkReveal | null = null;
  if (ship) {
    ship.hits += 1;
    if (ship.hits >= ship.cells.length) {
      ship.sunk = true;
      sunk = {
        key: ship.key,
        orient: ship.orient,
        cells: ship.cells,
        name: defFor(ship.key)?.name ?? ship.key,
      };
    }
  }

  const wiped = target.ships.every((s) => s.sunk);
  let next: Side | null;
  if (wiped) {
    next = null;
    state.phase = 'over';
    state.turn = null;
    state.winner = side;
  } else {
    next = hit && state.rules.extraShotOnHit ? side : targetSide;
    state.turn = next;
  }

  emit(state, { type: 'shot', by: side, idx, hit, sunk, next });
  if (wiped) emit(state, { type: 'over', winner: side });
  touch(state, now);
  return done(undefined);
}

/** Both sides must ask before the boards are wiped. */
export function requestRematch(
  state: MatchState,
  side: Side,
  now: number,
): Result<{ started: boolean }> {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'over') return fail('The battle is still live', 409);

  player.rematch = true;
  const both = Boolean(state.players.a?.rematch && state.players.b?.rematch);
  if (both) {
    (['a', 'b'] as const).forEach((s) => {
      const p = state.players[s];
      if (!p) return;
      p.ships = null;
      p.incoming = new Array<Mark>(CELLS).fill(0);
      p.shotsFired = 0;
      p.hitsLanded = 0;
      p.rematch = false;
    });
    state.phase = 'deploy';
    state.turn = null;
    state.winner = null;
    emit(state, { type: 'reset' });
  }
  touch(state, now);
  return done({ started: both });
}

/** Frees a seat. A walkout during battle hands the win to whoever stayed. */
export function leave(state: MatchState, side: Side, now: number): Result {
  if (!state.players[side]) return done(undefined);
  const opponent = OTHER[side];
  state.players[side] = null;
  emit(state, { type: 'left', side });

  if (state.phase === 'battle' && state.players[opponent]) {
    state.phase = 'over';
    state.turn = null;
    state.winner = opponent;
    emit(state, { type: 'over', winner: opponent });
  } else if (state.phase === 'deploy') {
    state.phase = 'lobby';
    state.turn = null;
  }
  touch(state, now);
  return done(undefined);
}

export function markSeen(state: MatchState, side: Side, now: number): void {
  const player = state.players[side];
  if (player) player.lastSeen = now;
}

/* ------------------------------------------------------------------ views ---- */

export type FleetSummary = {
  key: ShipKey;
  name: string;
  len: number;
  hits: number;
  sunk: boolean;
};

/** What one player is allowed to know. Un-sunk opponent cells are never included. */
export type MatchView = {
  roomId: string;
  version: number;
  phase: Phase;
  eventSeq: number;
  rules: MatchRules;
  /** Whose shot it is, from the viewer's perspective. */
  turn: 'you' | 'them' | null;
  outcome: 'win' | 'loss' | null;
  you: {
    side: Side;
    name: string;
    ready: boolean;
    fleet: Placement[] | null;
    /** Marks on your own board (shots taken at you). */
    board: Mark[];
    ships: FleetSummary[];
    shotsFired: number;
    hitsLanded: number;
    rematch: boolean;
  };
  them: {
    name: string | null;
    present: boolean;
    ready: boolean;
    /** Marks on the enemy board (shots you have fired). */
    board: Mark[];
    /** Only ships you have already sunk — the sole way enemy cells are revealed. */
    revealed: SunkReveal[];
    ships: FleetSummary[];
    rematch: boolean;
    lastSeen: number | null;
  };
  events: MatchEvent[];
};

function summarize(ships: ShipState[] | null): FleetSummary[] {
  if (!ships) {
    return SHIP_DEFS.map((d) => ({ key: d.key, name: d.name, len: d.len, hits: 0, sunk: false }));
  }
  return ships.map((s) => ({
    key: s.key,
    name: defFor(s.key)?.name ?? s.key,
    len: s.cells.length,
    hits: s.hits,
    sunk: s.sunk,
  }));
}

export function viewFor(state: MatchState, side: Side, since = 0): MatchView {
  const me = state.players[side];
  const them = state.players[OTHER[side]];
  if (!me) throw new Error('viewFor called for an unseated side');

  return {
    roomId: state.id,
    version: state.version,
    phase: state.phase,
    eventSeq: state.eventSeq,
    rules: state.rules,
    turn: state.turn ? (state.turn === side ? 'you' : 'them') : null,
    outcome: state.winner ? (state.winner === side ? 'win' : 'loss') : null,
    you: {
      side,
      name: me.name,
      ready: Boolean(me.ships),
      fleet: me.ships
        ? me.ships.map((s) => ({ key: s.key, orient: s.orient, cells: s.cells }))
        : null,
      board: me.incoming,
      ships: summarize(me.ships),
      shotsFired: me.shotsFired,
      hitsLanded: me.hitsLanded,
      rematch: me.rematch,
    },
    them: {
      name: them?.name ?? null,
      present: Boolean(them),
      ready: Boolean(them?.ships),
      board: them ? them.incoming : new Array<Mark>(CELLS).fill(0),
      revealed: (them?.ships ?? [])
        .filter((s) => s.sunk)
        .map((s) => ({
          key: s.key,
          orient: s.orient,
          cells: s.cells,
          name: defFor(s.key)?.name ?? s.key,
        })),
      ships: summarize(them?.ships ?? null),
      rematch: Boolean(them?.rematch),
      lastSeen: them?.lastSeen ?? null,
    },
    events: state.events.filter((e) => e.seq > since),
  };
}
