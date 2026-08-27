import type { NextRequest } from 'next/server';
import { sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, parseSince, readToken, resolveRoomId } from '@/lib/net/api';
import { isSpectatorToken } from '@/lib/net/protocol';
import { loadRoom, waitForVersion } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** How long a `wait=1` request holds the connection open before answering. */
const HOLD_MS = 25_000;

/**
 * GET /api/rooms/:id — the viewer's redacted snapshot plus any events they have
 * not seen. With `wait=1` the response is held until the room changes, which
 * keeps latency low without leaving route handlers for a socket transport.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const token = readToken(request);
  if (!token) return jsonError('Missing player token', 401);

  let state = await loadRoom(roomId);
  if (!state) return jsonError('Room not found', 404);

  const side = sideForToken(state, token);
  const spectating = isSpectatorToken(token);
  if (!side && !spectating) return jsonError('You are not seated in this match', 403);

  const since = parseSince(request);
  const knownVersion = Number(request.nextUrl.searchParams.get('v'));
  const wait = request.nextUrl.searchParams.get('wait') === '1';

  if (wait && Number.isFinite(knownVersion) && state.version <= knownVersion) {
    const updated = await waitForVersion(roomId, knownVersion, {
      holdMs: HOLD_MS,
      signal: request.signal,
    });
    // A null result means the room was disposed while this request was held.
    // Do not fall back to the stale snapshot: that would make a dead room look
    // available for one more response.
    if (!updated) return jsonError('Room not found', 404);
    state = updated;
  }

  // This handler never writes. It used to stamp a lastSeen heartbeat here, but
  // the state it holds was read outside the room lock: any join, deploy, or shot
  // committed during the hold would be clobbered by the write, stranding both
  // players. Reads stay read-only; lastSeen is stamped by the mutating routes.
  const seatNow = sideForToken(state, token) ?? side;

  return Response.json(
    { view: viewFor(state, seatNow ?? null, since) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
