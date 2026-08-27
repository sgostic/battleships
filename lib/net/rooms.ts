/**
 * Room persistence: the match state machine plus locking, TTLs, the quick-match
 * queue, and the long-poll wait used by the state endpoint.
 */

import {
  type MatchRules,
  type MatchState,
  type Mode,
  createMatch,
  isJoinable,
  shouldDisposeRoom,
} from '../game/match';
import { ROOM_ALPHABET, ROOM_CODE_LENGTH, SPECTATOR_TOKEN_PREFIX, normalizeRoomId } from './protocol';
import { getStore } from './store';

export { ROOM_CODE_LENGTH, normalizeRoomId };

/** Rooms self-destruct well after a game would have finished. */
const ROOM_TTL_SECONDS = 3 * 60 * 60;
const QUEUE_TTL_SECONDS = 15 * 60;
const LOCK_TTL_MS = 5000;
const LOCK_ATTEMPTS = 25;
const LOCK_RETRY_MS = 60;

/** Bumped whenever `MatchState`'s shape changes incompatibly. A room from before
 *  this schema is discarded rather than fed to rules that don't understand it —
 *  it will simply age out of its 3h TTL. */
const SCHEMA = 10;

const queueKey = (mode: Mode) => `sb:queue:${mode}`;
const roomKey = (id: string) => `sb:room:${id}`;
const lockKey = (id: string) => `sb:lock:${id}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function newRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return out;
}

export function newPlayerToken(): string {
  return Array.from(randomBytes(24), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSpectatorToken(): string {
  return `${SPECTATOR_TOKEN_PREFIX}${newPlayerToken()}`;
}

export async function loadRoom(id: string): Promise<MatchState | null> {
  const state = await getStore().getJSON<MatchState>(roomKey(id));
  if (state && state.schema !== SCHEMA) return null;
  return state;
}

export async function saveRoom(state: MatchState): Promise<void> {
  await getStore().setJSON(roomKey(state.id), state, ROOM_TTL_SECONDS);
}

export async function createRoom(
  mode: Mode,
  rules: Partial<MatchRules>,
  open: boolean,
): Promise<MatchState> {
  const store = getStore();
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newRoomCode();
    if (await store.getJSON(roomKey(id))) continue;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const state = createMatch(id, Date.now(), mode, rules, open, seed);
    await saveRoom(state);
    return state;
  }
  throw new Error('Could not allocate a free room code');
}

export type MutateOutcome<T> =
  | { ok: true; state: MatchState; value: T }
  | { ok: false; error: string; code: number };

/**
 * Read-modify-write under a short Redis lock. Turn ownership already serializes
 * most writes; the lock covers joins and simultaneous deploys.
 */
export async function mutateRoom<T>(
  id: string,
  mutate: (state: MatchState) => { ok: true; value: T } | { ok: false; error: string; code: number },
): Promise<MutateOutcome<T>> {
  const store = getStore();
  const token = newPlayerToken();
  const key = lockKey(id);

  let held = false;
  for (let i = 0; i < LOCK_ATTEMPTS; i++) {
    if (await store.acquire(key, token, LOCK_TTL_MS)) {
      held = true;
      break;
    }
    await sleep(LOCK_RETRY_MS);
  }
  if (!held) return { ok: false, error: 'The room is busy, try again', code: 503 };

  try {
    const state = await loadRoom(id);
    if (!state) return { ok: false, error: 'Room not found', code: 404 };

    const result = mutate(state);
    if (!result.ok) return result;

    // Dispose within the room lock so a completely abandoned room cannot be
    // resumed in the gap between its last mutation and deletion.
    if (shouldDisposeRoom(state)) {
      await store.del(roomKey(id));
      await store.lrem(queueKey(state.mode), id);
    } else {
      await saveRoom(state);
    }
    return { ok: true, state, value: result.value };
  } finally {
    await store.release(key, token);
  }
}

/* ------------------------------------------------------------- quick match ---- */

export async function enqueueRoom(mode: Mode, id: string): Promise<void> {
  await getStore().rpush(queueKey(mode), id, QUEUE_TTL_SECONDS);
}

export async function dequeueRoom(mode: Mode, id: string): Promise<void> {
  await getStore().lrem(queueKey(mode), id);
}

/**
 * Pops room codes until one is still waiting for at least one more seat. Stale
 * codes (expired, filled, or abandoned) are simply discarded.
 */
export async function takeJoinableRoom(mode: Mode, maxScans = 12): Promise<MatchState | null> {
  const store = getStore();
  for (let i = 0; i < maxScans; i++) {
    const id = await store.lpop(queueKey(mode));
    if (!id) return null;
    const state = await loadRoom(id);
    if (state && state.open && isJoinable(state)) return state;
  }
  return null;
}

/* -------------------------------------------------------------- long poll ---- */

/**
 * Resolves as soon as the room's version moves past `sinceVersion`, or when the
 * hold window expires. Polling Redis is the trade-off for keeping every online
 * interaction on plain App Router route handlers.
 */
export async function waitForVersion(
  id: string,
  sinceVersion: number,
  opts: { holdMs: number; signal?: AbortSignal },
): Promise<MatchState | null> {
  const started = Date.now();
  const deadline = started + opts.holdMs;
  let latest = await loadRoom(id);

  while (latest && latest.version <= sinceVersion && Date.now() < deadline) {
    if (opts.signal?.aborted) break;
    await sleep(pollInterval(Date.now() - started));
    latest = await loadRoom(id);
  }
  return latest;
}

/**
 * Checks often right after the opponent's move lands, then backs off. An idle
 * hold costs roughly a dozen reads instead of one every 700ms.
 */
function pollInterval(elapsedMs: number): number {
  if (elapsedMs < 3_000) return 250;
  if (elapsedMs < 8_000) return 600;
  return 1_500;
}
