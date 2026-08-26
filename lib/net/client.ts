/** Browser-side wrappers around the room route handlers. */

import type { MatchView, Mode, Side, Team } from '../game/match';
import type { Placement } from '../game/rules';
import { PLAYER_TOKEN_HEADER } from './protocol';

export type Session = {
  roomId: string;
  token: string;
  side: Side;
  view: MatchView;
  matched?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(
  url: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { [PLAYER_TOKEN_HEADER]: token } : {}),
      ...headers,
    },
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }
  return payload as T;
}

export function createRoom(
  name: string,
  opts: { open?: boolean; mode?: Mode } = {},
): Promise<Session> {
  return request<Session>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ name, open: opts.open ?? false, mode: opts.mode ?? 'duel' }),
  });
}

export function joinRoom(roomId: string, name: string, token?: string): Promise<Session> {
  return request<Session>(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    body: JSON.stringify({ name, token }),
    token,
  });
}

/** In-flight seat claims, keyed by room. */
const claims = new Map<string, Promise<Session>>();

/**
 * Claims a seat at most once per room per tab.
 *
 * Without this, a double-mounted effect (React strict mode, a fast remount)
 * fires two tokenless joins and the tab quietly occupies *both* seats, leaving
 * the real opponent with a 409. Sharing the in-flight promise means the second
 * caller gets the same seat and the same token.
 */
export function claimSeat(roomId: string, name: string): Promise<Session> {
  const pending = claims.get(roomId);
  if (pending) return pending;

  const attempt = (async () => {
    const stored = recallSession(roomId) ?? undefined;
    const session = await joinRoom(roomId, name, stored);
    rememberSession(roomId, session.token);
    return session;
  })();

  claims.set(roomId, attempt);
  // A failed claim must not be cached, or a retry could never succeed.
  attempt.catch(() => claims.delete(roomId));
  return attempt;
}

/** Drops the cached claim so `retry` can genuinely re-attempt. */
export function releaseClaim(roomId: string): void {
  claims.delete(roomId);
}

export function quickMatch(name: string, mode: Mode = 'duel'): Promise<Session> {
  return request<Session>('/api/matchmake', {
    method: 'POST',
    body: JSON.stringify({ name, mode }),
  });
}

export async function fetchView(opts: {
  roomId: string;
  token: string;
  since: number;
  version: number;
  wait: boolean;
  signal?: AbortSignal;
}): Promise<MatchView> {
  const params = new URLSearchParams({
    since: String(opts.since),
    v: String(opts.version),
  });
  if (opts.wait) params.set('wait', '1');
  const { view } = await request<{ view: MatchView }>(
    `/api/rooms/${encodeURIComponent(opts.roomId)}?${params}`,
    { token: opts.token, signal: opts.signal, cache: 'no-store' },
  );
  return view;
}

export async function postDeploy(
  roomId: string,
  token: string,
  fleet: Placement[],
  since: number,
): Promise<MatchView> {
  const { view } = await request<{ view: MatchView }>(
    `/api/rooms/${encodeURIComponent(roomId)}/deploy?since=${since}`,
    { method: 'POST', body: JSON.stringify({ fleet }), token },
  );
  return view;
}

export async function postFire(
  roomId: string,
  token: string,
  target: Side,
  idx: number,
  since: number,
): Promise<MatchView> {
  const { view } = await request<{ view: MatchView }>(
    `/api/rooms/${encodeURIComponent(roomId)}/fire?since=${since}`,
    { method: 'POST', body: JSON.stringify({ target, idx }), token },
  );
  return view;
}

export async function postTeam(
  roomId: string,
  token: string,
  team: Team | null,
  since: number,
): Promise<MatchView> {
  const { view } = await request<{ view: MatchView }>(
    `/api/rooms/${encodeURIComponent(roomId)}/team?since=${since}`,
    { method: 'POST', body: JSON.stringify({ team }), token },
  );
  return view;
}

export async function postReady(
  roomId: string,
  token: string,
  ready: boolean,
  since: number,
): Promise<MatchView> {
  const { view } = await request<{ view: MatchView }>(
    `/api/rooms/${encodeURIComponent(roomId)}/ready?since=${since}`,
    { method: 'POST', body: JSON.stringify({ ready }), token },
  );
  return view;
}

export async function postRematch(
  roomId: string,
  token: string,
  since: number,
): Promise<MatchView> {
  const { view } = await request<{ view: MatchView; started: boolean }>(
    `/api/rooms/${encodeURIComponent(roomId)}/rematch?since=${since}`,
    { method: 'POST', token },
  );
  return view;
}

/** Fire-and-forget on unload so the opponent is not left waiting on a ghost. */
export function leaveRoom(roomId: string, token: string): void {
  void fetch(`/api/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    headers: { [PLAYER_TOKEN_HEADER]: token },
    keepalive: true,
  }).catch(() => {});
}

/* ------------------------------------------------------------ local session ---- */

const tokenKey = (roomId: string) => `sb:token:${roomId}`;
const NAME_KEY = 'sb:name';

export function rememberSession(roomId: string, token: string): void {
  try {
    localStorage.setItem(tokenKey(roomId), token);
  } catch {
    /* private mode */
  }
}

export function recallSession(roomId: string): string | null {
  try {
    return localStorage.getItem(tokenKey(roomId));
  } catch {
    return null;
  }
}

export function forgetSession(roomId: string): void {
  try {
    localStorage.removeItem(tokenKey(roomId));
  } catch {
    /* private mode */
  }
}

export function rememberName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
}

export function recallName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
