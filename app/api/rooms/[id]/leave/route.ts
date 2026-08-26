import type { NextRequest } from 'next/server';
import { leave, sideForToken } from '@/lib/game/match';
import { jsonError, readToken, resolveRoomId } from '@/lib/net/api';
import { dequeueRoom, mutateRoom } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms/:id/leave — frees the seat. Sent on navigate-away so the
 * opponent is not left staring at a table nobody is sitting at.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const token = readToken(request);
  if (!token) return jsonError('Missing player token', 401);

  const outcome = await mutateRoom(roomId, (state) => {
    const side = sideForToken(state, token);
    if (!side) return { ok: true as const, value: null };
    leave(state, side, Date.now());
    return { ok: true as const, value: side };
  });

  if (!outcome.ok) return jsonError(outcome.error, outcome.code);
  await dequeueRoom(outcome.state.mode, roomId);
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
