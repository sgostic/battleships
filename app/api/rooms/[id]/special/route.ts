import type { NextRequest } from 'next/server';
import { respondSpecialMove, sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, parseSince, readJson, readToken, resolveRoomId } from '@/lib/net/api';
import { mutateRoom } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/** POST /api/rooms/:id/special — resolves the 2v2-only risk/reward strike. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const token = readToken(request);
  if (!token) return jsonError('Missing player token', 401);
  const body = await readJson(request);
  const outcome = await mutateRoom(roomId, (state) => {
    const side = sideForToken(state, token);
    if (!side) return { ok: false as const, error: 'You are not seated in this match', code: 403 };
    const res = respondSpecialMove(state, side, body.accept, body.target, Date.now());
    return res.ok ? { ok: true as const, value: side } : res;
  });
  if (!outcome.ok) return jsonError(outcome.error, outcome.code);
  return Response.json({ view: viewFor(outcome.state, outcome.value, parseSince(request)) }, { headers: { 'cache-control': 'no-store' } });
}
