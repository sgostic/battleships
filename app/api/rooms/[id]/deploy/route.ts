import type { NextRequest } from 'next/server';
import { deploy, sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, parseSince, readJson, readToken, resolveRoomId } from '@/lib/net/api';
import { mutateRoom } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/** POST /api/rooms/:id/deploy — commits a fleet. The server re-validates it. */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const token = readToken(request);
  if (!token) return jsonError('Missing player token', 401);
  const body = await readJson(request);

  const outcome = await mutateRoom(roomId, (state) => {
    const side = sideForToken(state, token);
    if (!side) return { ok: false as const, error: 'You are not seated in this match', code: 403 };
    const res = deploy(state, side, body.fleet, Date.now());
    return res.ok ? { ok: true as const, value: side } : res;
  });

  if (!outcome.ok) return jsonError(outcome.error, outcome.code);
  return Response.json(
    { view: viewFor(outcome.state, outcome.value, parseSince(request)) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
