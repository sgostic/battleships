/**
 * The match state machine. Pure and JSON-serializable so the exact same rules run
 * server-side (authoritative, persisted in Redis) and in the browser for solo play.
 *
 * Two modes share one machine: `duel` is the original 1v1 (seats a, b — each its
 * own one-player team), `duo` is 2v2 (seats a-d, two players per team). Turn order
 * interleaves by team once the battle starts; free targeting means a shot can land
 * on either living enemy board.
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

export type Side = 'a' | 'b' | 'c' | 'd';
export type Team = 'red' | 'blue';
export type Mode = 'duel' | 'duo';
export type SpecialKind = 'scorched-earth' | 'traitors-mark' | 'rapid-salvo' | 'allied-bastion';
export const SPECIAL_KINDS: readonly SpecialKind[] = ['scorched-earth', 'traitors-mark', 'rapid-salvo', 'allied-bastion'];

export const SEATS: Record<Mode, readonly Side[]> = {
  duel: ['a', 'b'],
  duo: ['a', 'b', 'c', 'd'],
};
export const TEAMS: readonly Team[] = ['red', 'blue'];
export const TEAM_SIZE: Record<Mode, number> = { duel: 1, duo: 2 };

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
  /** Secret. Never leaves the server for the opposing team. */
  token: string;
  name: string;
  /** duel: fixed at join. duo: chosen in the lobby, null until then. */
  team: Team | null;
  ships: ShipState[] | null;
  /** Shots fired at this player's board, indexed by cell. */
  incoming: Mark[];
  shotsFired: number;
  hitsLanded: number;
  /** Lobby ready-up. Distinct from `ships !== null` (deployed). */
  ready: boolean;
  /** This player's fleet is fully sunk; skipped in the turn rotation. */
  eliminated: boolean;
  rematch: boolean;
  lastSeen: number;
};

/** Read-only visitor identity. The token stays server-side. */
export type SpectatorState = {
  token: string;
  name: string;
  joinedAt: number;
};

export type SunkReveal = Placement & { name: string };

export type MatchEvent =
  | { seq: number; type: 'joined'; side: Side; name: string }
  | { seq: number; type: 'team'; side: Side; team: Team | null }
  | { seq: number; type: 'ready'; side: Side; ready: boolean }
  | { seq: number; type: 'deploying' }
  | { seq: number; type: 'deployed'; side: Side }
  | { seq: number; type: 'battle'; turn: Side; order: Side[] }
  | {
      seq: number;
      type: 'shot';
      by: Side;
      at: Side;
      idx: number;
      hit: boolean;
      sunk: SunkReveal | null;
      next: Side | null;
    }
  | { seq: number; type: 'eliminated'; side: Side }
  | { seq: number; type: 'special-strike'; by: Side; ally: Side; bombed: number[]; target: Side; destroyed: SunkReveal[] }
  | { seq: number; type: 'special-mark'; by: Side; ally: Side; allySunk: SunkReveal; target: Side; idx: number; sunk: SunkReveal | null }
  | { seq: number; type: 'special-salvo'; by: Side; ally: Side; shots: number; skips: number }
  | { seq: number; type: 'special-bastion'; by: Side; ally: Side; turns: number }
  | { seq: number; type: 'skipped'; side: Side; remaining: number }
  | { seq: number; type: 'over'; winner: Team }
  | { seq: number; type: 'left'; side: Side }
  | { seq: number; type: 'reset' };

export type ChatMessage = { id: number; side: Side; name: string; text: string; at: number };

export type MatchRules = {
  extraShotOnHit: boolean;
  /** duo: nobody deploys until every seat is filled, teamed, and ready. */
  lobbyReady: boolean;
};

/** The 2v2-only high-risk strike. Each commander has one charge per match. */
export type SpecialMoveState = {
  usedBy: Record<SpecialKind, Side[]>;
  rapidSalvo: { side: Side; shotsRemaining: number } | null;
  allySkips: { side: Side; remaining: number } | null;
  bastion: { protectedSide: Side; allySide: Side; remainingEnemyTurns: number; activeEnemy: Side | null } | null;
};

export type MatchState = {
  id: string;
  /** Bumped whenever the shape of this blob changes incompatibly. */
  schema: 9;
  mode: Mode;
  version: number;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  turn: Side | null;
  /** Epoch time when the current turn began, used by the online shot clock. */
  turnStartedAt: number | null;
  /** Frozen the moment the battle starts; elimination skips seats, never reorders. */
  turnOrder: Side[];
  winner: Team | null;
  players: Record<Side, PlayerState | null>;
  spectators: SpectatorState[];
  events: MatchEvent[];
  eventSeq: number;
  chat: ChatMessage[];
  rules: MatchRules;
  specialMove: SpecialMoveState | null;
  /** Listed in the quick-match queue. */
  open: boolean;
};

/** Events older than this are dropped; a lagging client resyncs from the snapshot. */
const EVENT_HISTORY = 160;

export type Fail = { ok: false; error: string; code: number };
export type Done<T = undefined> = { ok: true; value: T };
export type Result<T = undefined> = Done<T> | Fail;

const fail = (error: string, code = 400): Fail => ({ ok: false, error, code });
const done = <T,>(value: T): Done<T> => ({ ok: true, value });

export function createMatch(
  id: string,
  now: number,
  mode: Mode,
  rules: Partial<MatchRules> = {},
  open = false,
): MatchState {
  return {
    id,
    schema: 9,
    mode,
    version: 0,
    createdAt: now,
    updatedAt: now,
    phase: 'lobby',
    turn: null,
    turnStartedAt: null,
    turnOrder: [],
    winner: null,
    players: { a: null, b: null, c: null, d: null },
    spectators: [],
    events: [],
    eventSeq: 0,
    chat: [],
    rules: {
      extraShotOnHit: rules.extraShotOnHit ?? true,
      lobbyReady: rules.lobbyReady ?? mode === 'duo',
    },
    specialMove: mode === 'duo' ? newSpecialMoveState() : null,
    open,
  };
}

export function sendChat(state: MatchState, side: Side, raw: unknown, now: number): Result {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240) : '';
  if (!text) return fail('Message cannot be empty');
  state.chat.push({ id: state.eventSeq + state.chat.length + 1, side, name: player.name, text, at: now });
  if (state.chat.length > 100) state.chat.splice(0, state.chat.length - 100);
  touch(state, now);
  return done(undefined);
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

function newPlayer(token: string, name: string, now: number, team: Team | null): PlayerState {
  return {
    token,
    name,
    team,
    ships: null,
    incoming: new Array<Mark>(CELLS).fill(0),
    shotsFired: 0,
    hitsLanded: 0,
    ready: false,
    eliminated: false,
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
  return safe || `Commander ${side.toUpperCase()}`;
}

/** Adds a read-only visitor to the public roster without exposing its token. */
export function registerSpectator(state: MatchState, token: string, name: unknown, now: number): void {
  const existing = state.spectators.find((spectator) => spectator.token === token);
  if (existing) return;
  state.spectators.push({ token, name: cleanName(name, 'a'), joinedAt: now });
  touch(state, now);
}

/* --------------------------------------------------------------- helpers ---- */

export function seatsOf(state: MatchState): readonly Side[] {
  return SEATS[state.mode];
}

export function teamOf(state: MatchState, side: Side): Team | null {
  return state.players[side]?.team ?? null;
}

/** Seated, undestroyed players on a team. */
export function livingOn(state: MatchState, team: Team): Side[] {
  return seatsOf(state).filter((s) => {
    const p = state.players[s];
    return Boolean(p && p.team === team && !p.eliminated);
  });
}

export function sideForToken(state: MatchState, token: string): Side | null {
  for (const side of seatsOf(state)) {
    if (state.players[side]?.token === token) return side;
  }
  return null;
}

export function seatsTaken(state: MatchState): number {
  return seatsOf(state).filter((s) => state.players[s]).length;
}

export function isJoinable(state: MatchState): boolean {
  return seatsTaken(state) < seatsOf(state).length && state.phase === 'lobby';
}

/** A room with no remaining crew has no resumable state. */
export function shouldDisposeRoom(state: MatchState): boolean {
  return seatsTaken(state) === 0;
}

/** Red seat 1, Blue seat 1, Red seat 2, Blue seat 2, … — frozen once the battle starts. */
function buildTurnOrder(state: MatchState): Side[] {
  if (state.mode === 'duel') return ['a', 'b'];
  const redSeats = seatsOf(state).filter((s) => state.players[s]?.team === 'red');
  const blueSeats = seatsOf(state).filter((s) => state.players[s]?.team === 'blue');
  const order: Side[] = [];
  for (let i = 0; i < Math.max(redSeats.length, blueSeats.length); i++) {
    if (redSeats[i]) order.push(redSeats[i]);
    if (blueSeats[i]) order.push(blueSeats[i]);
  }
  return order;
}

/** Next living seat after `from` in the frozen turn order, wrapping; null if none remain. */
function advanceTurn(state: MatchState, from: Side): Side | null {
  const order = state.turnOrder;
  const start = order.indexOf(from);
  for (let step = 1; step <= order.length; step++) {
    const side = order[(start + step) % order.length];
    const player = state.players[side];
    if (player && !player.eliminated) {
      const skips = state.specialMove?.allySkips;
      if (skips?.side === side && skips.remaining > 0) {
        skips.remaining -= 1;
        emit(state, { type: 'skipped', side, remaining: skips.remaining });
        if (skips.remaining === 0) state.specialMove!.allySkips = null;
        continue;
      }
      return side;
    }
  }
  return null;
}

/** Starts an actual new turn. Extra shots deliberately do not count as a new turn. */
function startTurn(state: MatchState, side: Side | null, now: number): void {
  state.turn = side;
  state.turnStartedAt = side === null ? null : now;
  const bastion = state.specialMove?.bastion;
  if (!bastion || !side) return;
  const protectedTeam = state.players[bastion.protectedSide]?.team;
  const ally = state.players[bastion.allySide];
  const actor = state.players[side];
  if (!protectedTeam || !ally || ally.eliminated) {
    state.specialMove!.bastion = null;
  } else if (bastion.remainingEnemyTurns === 0 && bastion.activeEnemy !== side) {
    state.specialMove!.bastion = null;
  } else if (actor?.team !== protectedTeam && bastion.remainingEnemyTurns > 0) {
    bastion.activeEnemy = side;
    bastion.remainingEnemyTurns -= 1;
  } else if (actor?.team === protectedTeam) {
    bastion.activeEnemy = null;
  }
}

function sunkReveal(ship: ShipState): SunkReveal {
  return { key: ship.key, orient: ship.orient, cells: ship.cells, name: defFor(ship.key)?.name ?? ship.key };
}

function randomCells(count: number): number[] {
  const cells = Array.from({ length: CELLS }, (_, idx) => idx);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (cells.length - i));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.slice(0, count);
}

function newSpecialMoveState(): SpecialMoveState {
  return {
    usedBy: { 'scorched-earth': [], 'traitors-mark': [], 'rapid-salvo': [], 'allied-bastion': [] },
    rapidSalvo: null,
    allySkips: null,
    bastion: null,
  };
}

function canStart(state: MatchState): boolean {
  const seats = seatsOf(state);
  if (seats.some((s) => !state.players[s])) return false;
  if (!state.rules.lobbyReady) return true;
  if (!TEAMS.every((t) => livingOn(state, t).length === TEAM_SIZE[state.mode])) return false;
  return seats.every((s) => state.players[s]!.ready);
}

function startIfReady(state: MatchState): void {
  if (state.phase !== 'lobby') return;
  if (!canStart(state)) return;
  state.phase = 'deploy';
  state.open = false;
  emit(state, { type: 'deploying' });
}

/** Seats a player. Returns the side they were seated on. */
export function join(state: MatchState, token: string, name: string, now: number): Result<Side> {
  const existing = sideForToken(state, token);
  if (existing) {
    state.players[existing]!.lastSeen = now;
    return done(existing);
  }
  if (!isJoinable(state)) return fail('This match is already full', 409);

  const side = seatsOf(state).find((s) => !state.players[s]);
  if (!side) return fail('This match is already full', 409);
  const team: Team | null = state.mode === 'duel' ? (side === 'a' ? 'red' : 'blue') : null;
  state.players[side] = newPlayer(token, cleanName(name, side), now, team);
  emit(state, { type: 'joined', side, name: state.players[side]!.name });

  startIfReady(state);
  touch(state, now);
  return done(side);
}

/** Lobby-only: choose (or clear) a team. Duo only — duel assigns teams at join. */
export function setTeam(state: MatchState, side: Side, teamRaw: unknown, now: number): Result {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.mode !== 'duo') return fail('Team choice is not available in this match', 409);
  if (state.phase !== 'lobby') return fail('Teams are locked in', 409);
  if (teamRaw !== 'red' && teamRaw !== 'blue' && teamRaw !== null) {
    return fail('Unknown team', 422);
  }
  const team = teamRaw as Team | null;
  if (team && team !== player.team && livingOn(state, team).length >= TEAM_SIZE[state.mode]) {
    return fail('That team is full', 409);
  }
  player.team = team;
  player.ready = false;
  player.lastSeen = now;
  emit(state, { type: 'team', side, team });
  touch(state, now);
  return done(undefined);
}

/** Lobby-only: ready up. The battle starts once every seat is filled and ready. */
export function setReady(state: MatchState, side: Side, readyRaw: unknown, now: number): Result {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'lobby') return fail('Too late to change readiness', 409);
  if (typeof readyRaw !== 'boolean') return fail('Malformed ready flag', 422);
  if (readyRaw && !player.team) return fail('Choose a team first', 409);
  player.ready = readyRaw;
  player.lastSeen = now;
  emit(state, { type: 'ready', side, ready: readyRaw });
  startIfReady(state);
  touch(state, now);
  return done(undefined);
}

/** Commits a fleet. Starts the battle once every seat has deployed. */
export function deploy(state: MatchState, side: Side, fleet: unknown, now: number): Result {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'deploy') {
    return fail(state.phase === 'lobby' ? 'Waiting for the rest of the crew' : 'Deployment has closed', 409);
  }
  if (player.ships) return fail('Your fleet is already deployed', 409);
  player.lastSeen = now;

  const check = validateFleet(fleet);
  if (!check.ok) return fail(check.error, 422);

  player.ships = check.fleet.map((p) => ({ ...p, hits: 0, sunk: false }));
  emit(state, { type: 'deployed', side });

  const seats = seatsOf(state);
  if (seats.every((s) => state.players[s]?.ships)) {
    state.turnOrder = buildTurnOrder(state);
    state.phase = 'battle';
    startTurn(state, state.turnOrder[0] ?? null, now);
    emit(state, { type: 'battle', turn: state.turn as Side, order: state.turnOrder });
  }
  touch(state, now);
  return done(undefined);
}

/** Resolves a shot against a chosen enemy board. The server is the only place hit/miss is decided. */
export function fire(state: MatchState, side: Side, targetRaw: unknown, idxRaw: unknown, now: number): Result {
  const shooter = state.players[side];
  if (!shooter) return fail('You are not seated in this match', 403);
  if (state.phase !== 'battle') return fail('No battle in progress', 409);
  if (state.turn !== side) return fail('Not your turn', 409);

  const seats = seatsOf(state);
  if (typeof targetRaw !== 'string' || !(seats as string[]).includes(targetRaw)) {
    return fail('Unknown target', 422);
  }
  const targetSide = targetRaw as Side;
  const target = state.players[targetSide];
  if (!target) return fail('That seat is empty', 409);
  if (target.team === shooter.team) return fail('That is a friendly board', 409);
  const bastion = state.specialMove?.bastion;
  if (bastion?.activeEnemy === side && targetSide === bastion.protectedSide) {
    return fail('Allied Bastion is active — you must target their teammate', 409);
  }
  if (target.eliminated) return fail('That fleet is already destroyed', 409);
  if (!target.ships) return fail('Opponent has not deployed', 409);

  const idx = idxRaw;
  if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= CELLS) {
    return fail('Target outside the grid', 422);
  }
  if (target.incoming[idx] !== 0) return fail('You already fired at that cell', 409);

  shooter.lastSeen = now;
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
      sunk = sunkReveal(ship);
    }
  }

  if (target.ships.every((s) => s.sunk) && !target.eliminated) {
    target.eliminated = true;
    emit(state, { type: 'eliminated', side: targetSide });
    if (state.specialMove?.bastion?.allySide === targetSide) state.specialMove.bastion = null;
  }

  let next: Side | null;
  const foeTeam = target.team as Team;
  if (livingOn(state, foeTeam).length === 0) {
    next = null;
    state.phase = 'over';
    state.turn = null;
    state.winner = shooter.team;
  } else {
    const salvo = state.specialMove?.rapidSalvo;
    if (salvo?.side === side) {
      salvo.shotsRemaining -= 1;
      if (salvo.shotsRemaining > 0) {
        next = side;
      } else {
        state.specialMove!.rapidSalvo = null;
        next = hit && state.rules.extraShotOnHit ? side : advanceTurn(state, side);
      }
    } else {
      next = hit && state.rules.extraShotOnHit ? side : advanceTurn(state, side);
    }
    if (next === side) {
      state.turn = next;
      state.turnStartedAt = now;
    } else {
      startTurn(state, next, now);
    }
  }

  emit(state, { type: 'shot', by: side, at: targetSide, idx, hit, sunk, next });
  if (state.phase === 'over') emit(state, { type: 'over', winner: state.winner as Team });
  touch(state, now);
  return done(undefined);
}

/** Spends one of this commander's 2v2 tactical action charges. */
export function launchSpecialMove(state: MatchState, side: Side, kindRaw: unknown, targetRaw: unknown, now: number): Result {
  const special = state.specialMove;
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'battle' || state.mode !== 'duo') return fail('No special strike is available', 409);
  if (state.turn !== side) return fail('Not your turn', 409);
  if (!special || !SPECIAL_KINDS.includes(kindRaw as SpecialKind)) return fail('Unknown tactical action', 422);
  const kind = kindRaw as SpecialKind;
  if (special.usedBy[kind].includes(side)) return fail('You have already spent this tactical action', 409);
  const allySide = SEATS.duo.find((candidate) => candidate !== side && state.players[candidate]?.team === player.team);
  const ally = allySide ? state.players[allySide] : null;
  if (!allySide || !ally || !ally.ships || ally.eliminated) return fail('Your teammate must still be afloat', 409);
  if (kind === 'rapid-salvo') {
    special.usedBy[kind].push(side);
    special.rapidSalvo = { side, shotsRemaining: 2 };
    special.allySkips = { side: allySide, remaining: 3 };
    player.lastSeen = now;
    state.turnStartedAt = now;
    emit(state, { type: 'special-salvo', by: side, ally: allySide, shots: 2, skips: 3 });
    touch(state, now);
    return done(undefined);
  }
  if (kind === 'allied-bastion') {
    special.usedBy[kind].push(side);
    special.bastion = { protectedSide: side, allySide, remainingEnemyTurns: 4, activeEnemy: null };
    player.lastSeen = now;
    emit(state, { type: 'special-bastion', by: side, ally: allySide, turns: 4 });
    startTurn(state, advanceTurn(state, side), now);
    touch(state, now);
    return done(undefined);
  }
  const allyTargets = ally.ships.filter((ship) => !ship.sunk);
  if (!allyTargets.length) return fail('Your teammate has no ship left to sacrifice', 409);

  if (kind === 'scorched-earth') {
    if (typeof targetRaw !== 'string' || !(SEATS.duo as readonly string[]).includes(targetRaw)) return fail('Choose an opposing fleet', 422);
    const targetSide = targetRaw as Side;
    const target = state.players[targetSide];
    if (!target || target.team === player.team || target.eliminated || !target.ships) return fail('Choose a living opponent', 409);
    const destroyable = target.ships.filter((ship) => !ship.sunk);
    if (destroyable.length < 2) return fail('That opponent has fewer than two ships remaining', 409);
    special.usedBy[kind].push(side);
    player.lastSeen = now;
    const bombed = randomCells(Math.ceil(CELLS * 0.3));
    for (const idx of bombed) {
      if (ally.incoming[idx] !== 0) continue;
      const ship = ally.ships.find((candidate) => !candidate.sunk && candidate.cells.includes(idx));
      ally.incoming[idx] = ship ? 2 : 1;
      if (ship) ship.hits += 1;
    }
    ally.ships.filter((ship) => !ship.sunk && ship.hits >= ship.cells.length).forEach((ship) => { ship.sunk = true; });
    const destroyed = destroyable.sort(() => Math.random() - 0.5).slice(0, 2).map((ship) => {
      ship.sunk = true; ship.hits = ship.cells.length;
      ship.cells.forEach((idx) => { target.incoming[idx] = 2; });
      return sunkReveal(ship);
    });
    if (target.ships.every((ship) => ship.sunk) && !target.eliminated) {
      target.eliminated = true; emit(state, { type: 'eliminated', side: targetSide });
    }
    emit(state, { type: 'special-strike', by: side, ally: allySide, bombed, target: targetSide, destroyed });
  } else {
    const enemySides = seatsOf(state).filter((candidate) => {
      const enemy = state.players[candidate];
      return Boolean(enemy && enemy.team !== player.team && !enemy.eliminated && enemy.ships?.some((ship) => !ship.sunk));
    });
    const targetSide = enemySides[Math.floor(Math.random() * enemySides.length)];
    const target = targetSide ? state.players[targetSide] : null;
    if (!target || !target.ships) return fail('No enemy ship can be marked', 409);
    const targetShips = target.ships.filter((ship) => !ship.sunk);
    const targetShip = targetShips[Math.floor(Math.random() * targetShips.length)];
    const idx = targetShip.cells.find((cell) => target.incoming[cell] === 0) ?? targetShip.cells[0];
    const allyShip = allyTargets[Math.floor(Math.random() * allyTargets.length)];
    special.usedBy[kind].push(side);
    player.lastSeen = now; player.shotsFired += 1; player.hitsLanded += 1;
    target.incoming[idx] = 2; targetShip.hits += 1;
    let sunk: SunkReveal | null = null;
    if (targetShip.hits >= targetShip.cells.length) { targetShip.sunk = true; sunk = sunkReveal(targetShip); }
    allyShip.sunk = true; allyShip.hits = allyShip.cells.length;
    allyShip.cells.forEach((cell) => { ally.incoming[cell] = 2; });
    const allySunk = sunkReveal(allyShip);
    if (target.ships.every((ship) => ship.sunk) && !target.eliminated) { target.eliminated = true; emit(state, { type: 'eliminated', side: targetSide }); }
    emit(state, { type: 'special-mark', by: side, ally: allySide, allySunk, target: targetSide, idx, sunk });
  }
  if (ally.ships.every((ship) => ship.sunk) && !ally.eliminated) { ally.eliminated = true; emit(state, { type: 'eliminated', side: allySide }); }
  const teamsAlive = TEAMS.filter((team) => livingOn(state, team).length > 0);
  if (teamsAlive.length === 1) {
    state.phase = 'over'; state.turn = null; state.turnStartedAt = null; state.winner = teamsAlive[0];
    emit(state, { type: 'over', winner: teamsAlive[0] });
  } else {
    // Taking the strike is the commander's whole turn; declining is not.
    startTurn(state, advanceTurn(state, side), now);
  }
  touch(state, now);
  return done(undefined);
}

export function autoFire(state: MatchState, side: Side, now: number): Result<{ target: Side; idx: number }> {
  if (state.turnStartedAt === null || now - state.turnStartedAt < 20_000) return fail('The shot clock has not expired', 409);
  const protectedSide = state.specialMove?.bastion?.activeEnemy === side ? state.specialMove.bastion.protectedSide : null;
  const choices = seatsOf(state).flatMap((target) => {
    const player = state.players[target];
    if (!player || target === protectedSide || player.team === teamOf(state, side) || player.eliminated || !player.ships) return [];
    return player.incoming.flatMap((mark, idx) => (mark === 0 ? [{ target, idx }] : []));
  });
  if (!choices.length) return fail('No legal targets remain', 409);
  const choice = choices[Math.floor(Math.random() * choices.length)];
  const result = fire(state, side, choice.target, choice.idx, now);
  return result.ok ? done(choice) : result;
}


/** Every present seat must ask before the boards are wiped. */
export function requestRematch(
  state: MatchState,
  side: Side,
  now: number,
): Result<{ started: boolean }> {
  const player = state.players[side];
  if (!player) return fail('You are not seated in this match', 403);
  if (state.phase !== 'over') return fail('The battle is still live', 409);

  player.rematch = true;
  player.lastSeen = now;
  const seats = seatsOf(state);
  const all = seats.every((s) => state.players[s]?.rematch);
  if (all) {
    seats.forEach((s) => {
      const p = state.players[s];
      if (!p) return;
      p.ships = null;
      p.incoming = new Array<Mark>(CELLS).fill(0);
      p.shotsFired = 0;
      p.hitsLanded = 0;
      p.eliminated = false;
      p.rematch = false;
    });
    state.phase = 'deploy';
    state.turn = null;
    state.winner = null;
    state.turnOrder = [];
    state.specialMove = state.mode === 'duo' ? newSpecialMoveState() : null;
    emit(state, { type: 'reset' });
  }
  touch(state, now);
  return done({ started: all });
}

/** Frees a seat. A walkout during battle costs that player's whole team the match
 *  once none of their seats remain. */
export function leave(state: MatchState, side: Side, now: number): Result {
  const player = state.players[side];
  if (!player) return done(undefined);
  const team = player.team;
  state.players[side] = null;
  emit(state, { type: 'left', side });

  if (state.phase === 'battle' && team) {
    if (state.turn === side) state.turn = advanceTurn(state, side);
    if (livingOn(state, team).length === 0) {
      const winner = TEAMS.find((t) => t !== team)!;
      state.phase = 'over';
      state.turn = null;
      state.winner = winner;
      emit(state, { type: 'over', winner });
    }
  } else if (state.phase === 'deploy') {
    // Committed fleets are kept; everyone re-readies once the room refills.
    state.phase = 'lobby';
    state.turn = null;
    seatsOf(state).forEach((s) => {
      const p = state.players[s];
      if (p) p.ready = false;
    });
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

export type Relation = 'self' | 'ally' | 'foe';

/** What one player is allowed to know about one seat (including their own). */
export type SeatView = {
  side: Side;
  team: Team | null;
  relation: Relation;
  name: string | null;
  present: boolean;
  ready: boolean;
  /** Fleet committed. */
  deployed: boolean;
  eliminated: boolean;
  /** Marks on this board — safe to publish to everyone: whoever placed them
   *  already knows, and this board's own team already sees their own pegs. */
  board: Mark[];
  /** Hull positions. Only for `self` and `ally` — the one genuinely secret field. */
  fleet: Placement[] | null;
  /** Sunk hulls on this board — the only way a foe's cells are ever revealed. */
  revealed: SunkReveal[];
  ships: FleetSummary[];
  shotsFired: number;
  hitsLanded: number;
  rematch: boolean;
  lastSeen: number | null;
};

/** What one player is allowed to know about the whole match. */
export type MatchView = {
  roomId: string;
  version: number;
  mode: Mode;
  phase: Phase;
  eventSeq: number;
  rules: MatchRules;
  /** Remaining per-player tactical action charges. */
  specials: Record<SpecialKind, boolean>;
  /** When set, this viewer must target this enemy while Allied Bastion is active. */
  forcedTarget: Side | null;
  /** Public tactical status so opponents can see who Allied Bastion protects. */
  bastion: { protectedSide: Side; targetSide: Side; remainingEnemyTurns: number; activeEnemy: Side | null } | null;
  /** Null for a read-only spectator. */
  you: Side | null;
  yourTeam: Team | null;
  /** Spectators receive public board marks and sunk reveals, but no fleets. */
  spectating: boolean;
  /** Public names only; spectator tokens never leave the server. */
  spectators: { name: string; joinedAt: number }[];
  seats: SeatView[];
  turn: Side | null;
  turnStartedAt: number | null;
  turnOrder: Side[];
  outcome: 'win' | 'loss' | null;
  events: MatchEvent[];
  chat: ChatMessage[];
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

function seatView(state: MatchState, viewer: Side | null, side: Side): SeatView {
  const p = state.players[side];
  const viewerTeam = viewer ? state.players[viewer]?.team ?? null : null;
  const relation: Relation =
    side === viewer ? 'self' : p?.team && p.team === viewerTeam ? 'ally' : 'foe';

  return {
    side,
    team: p?.team ?? null,
    relation,
    name: p?.name ?? null,
    present: Boolean(p),
    ready: Boolean(p?.ready),
    deployed: Boolean(p?.ships),
    eliminated: Boolean(p?.eliminated),
    board: p ? p.incoming : new Array<Mark>(CELLS).fill(0),
    fleet:
      relation !== 'foe' && p?.ships
        ? p.ships.map((s) => ({ key: s.key, orient: s.orient, cells: s.cells }))
        : null,
    revealed: (p?.ships ?? [])
      .filter((s) => s.sunk)
      .map((s) => ({
        key: s.key,
        orient: s.orient,
        cells: s.cells,
        name: defFor(s.key)?.name ?? s.key,
      })),
    ships: summarize(p?.ships ?? null),
    shotsFired: p?.shotsFired ?? 0,
    hitsLanded: p?.hitsLanded ?? 0,
    rematch: Boolean(p?.rematch),
    lastSeen: p?.lastSeen ?? null,
  };
}

export function viewFor(state: MatchState, viewer: Side | null, since = 0): MatchView {
  const me = viewer ? state.players[viewer] : null;
  if (viewer && !me) throw new Error('viewFor called for an unseated side');

  return {
    roomId: state.id,
    version: state.version,
    mode: state.mode,
    phase: state.phase,
    eventSeq: state.eventSeq,
    rules: state.rules,
    specials: Object.fromEntries(SPECIAL_KINDS.map((kind) => [kind, Boolean(viewer && state.specialMove && !state.specialMove.usedBy[kind].includes(viewer))])) as Record<SpecialKind, boolean>,
    forcedTarget: state.specialMove?.bastion?.activeEnemy === viewer
      ? state.specialMove.bastion.allySide
      : null,
    bastion: state.specialMove?.bastion
      ? {
          protectedSide: state.specialMove.bastion.protectedSide,
          targetSide: state.specialMove.bastion.allySide,
          remainingEnemyTurns: state.specialMove.bastion.remainingEnemyTurns,
          activeEnemy: state.specialMove.bastion.activeEnemy,
        }
      : null,
    you: viewer,
    yourTeam: me?.team ?? null,
    spectating: viewer === null,
    spectators: state.spectators.map(({ name, joinedAt }) => ({ name, joinedAt })),
    seats: seatsOf(state).map((s) => seatView(state, viewer, s)),
    turn: state.turn,
    turnStartedAt: state.turnStartedAt,
    turnOrder: state.turnOrder,
    outcome: state.winner && me ? (state.winner === me.team ? 'win' : 'loss') : null,
    events: state.events.filter((e) => e.seq > since),
    chat: state.chat ?? [],
  };
}

/* -------------------------------------------------------------- selectors ---- */

export function selfSeat(view: MatchView): SeatView {
  return view.seats.find((s) => s.side === view.you)!;
}

export function allySeat(view: MatchView): SeatView | null {
  return view.seats.find((s) => s.relation === 'ally') ?? null;
}

export function foeSeats(view: MatchView): SeatView[] {
  return view.seats.filter((s) => s.relation === 'foe');
}

export function isYourTurn(view: MatchView): boolean {
  return view.turn === view.you;
}
