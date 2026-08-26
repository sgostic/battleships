import type { NextRequest } from 'next/server';
import { requestRematch, sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, parseSince, readToken, resolveRoomId } from '@/lib/net/api';
import { mutateRoom } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/** POST /api/rooms/:id/rematch — boards reset once both sides have asked. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const token = readToken(request);
  if (!token) return jsonError('Missing player token', 401);

  const outcome = await mutateRoom(roomId, (state) => {
    const side = sideForToken(state, token);
    if (!side) return { ok: false as const, error: 'You are not seated in this match', code: 403 };
    const res = requestRematch(state, side, Date.now());
    return res.ok ? { ok: true as const, value: { side, started: res.value.started } } : res;
  });

  if (!outcome.ok) return jsonError(outcome.error, outcome.code);
  return Response.json(
    {
      started: outcome.value.started,
      view: viewFor(outcome.state, outcome.value.side, parseSince(request)),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
