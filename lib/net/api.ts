/** Small helpers shared by the room route handlers. */

import type { NextRequest } from 'next/server';
import { type MatchState, type Side, type MatchView, sideForToken, viewFor } from '../game/match';
import { PLAYER_TOKEN_HEADER, normalizeRoomId } from './protocol';
import { loadRoom } from './rooms';


export function jsonError(error: string, code: number): Response {
  return Response.json({ error }, { status: code });
}

/** Players identify themselves with an opaque token held in localStorage. */
export function readToken(request: NextRequest): string | null {
  const header = request.headers.get(PLAYER_TOKEN_HEADER);
  if (header) return header.trim() || null;
  const query = request.nextUrl.searchParams.get('token');
  return query?.trim() || null;
}

export async function readJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function resolveRoomId(ctx: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await ctx.params;
  return normalizeRoomId(id);
}

export type Seat = { state: MatchState; side: Side; token: string };

/** Loads the room and checks the caller actually holds a seat in it. */
export async function requireSeat(
  roomId: string,
  request: NextRequest,
): Promise<Seat | { error: Response }> {
  const token = readToken(request);
  if (!token) return { error: jsonError('Missing player token', 401) };

  const state = await loadRoom(roomId);
  if (!state) return { error: jsonError('Room not found', 404) };

  const side = sideForToken(state, token);
  if (!side) return { error: jsonError('You are not seated in this match', 403) };

  return { state, side, token };
}

export function viewResponse(
  state: MatchState,
  side: Side,
  since: number,
  extra: Record<string, unknown> = {},
): Response {
  const view: MatchView = viewFor(state, side, since);
  return Response.json({ ...extra, view }, { headers: { 'cache-control': 'no-store' } });
}

export function parseSince(request: NextRequest): number {
  const raw = Number(request.nextUrl.searchParams.get('since'));
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}
