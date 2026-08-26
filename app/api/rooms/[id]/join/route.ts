import type { NextRequest } from 'next/server';
import { cleanName, join, sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, readJson, readToken, resolveRoomId } from '@/lib/net/api';
import { dequeueRoom, mutateRoom, newPlayerToken } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms/:id/join — takes a free seat, or resumes an existing seat
 * when the caller already holds a token for this room.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const body = await readJson(request);
  const existingToken = readToken(request) ?? (typeof body.token === 'string' ? body.token : null);
  const token = existingToken || newPlayerToken();

  const outcome = await mutateRoom(roomId, (state) => {
    const already = sideForToken(state, token);
    if (already) return { ok: true as const, value: already };
    return join(state, token, cleanName(body.name, state.players.a ? 'b' : 'a'), Date.now());
  });

  if (!outcome.ok) return jsonError(outcome.error, outcome.code);

  // A filled room should no longer be offered to quick-match callers.
  if (!outcome.state.open) await dequeueRoom(outcome.state.mode, roomId);

  return Response.json(
    { roomId, token, side: outcome.value, view: viewFor(outcome.state, outcome.value) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
