import type { NextRequest } from 'next/server';
import { cleanName, join, sideForToken, viewFor } from '@/lib/game/match';
import { jsonError, readJson, readToken, requiredName, resolveRoomId } from '@/lib/net/api';
import { isSpectatorToken } from '@/lib/net/protocol';
import { dequeueRoom, mutateRoom, newPlayerToken, newSpectatorToken } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/**
 * POST /api/rooms/:id/join — takes a free seat, or resumes an existing seat
 * when the caller already holds a token for this room.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const roomId = await resolveRoomId(ctx);
  const body = await readJson(request);
  const name = requiredName(body);
  if (name instanceof Response) return name;
  const existingToken = readToken(request) ?? (typeof body.token === 'string' ? body.token : null);
  const token = existingToken || newPlayerToken();

  const outcome = await mutateRoom(roomId, (state) => {
    if (isSpectatorToken(token)) return { ok: true as const, value: null };
    const already = sideForToken(state, token);
    if (already) return { ok: true as const, value: already };
    const seated = join(state, token, cleanName(name, state.players.a ? 'b' : 'a'), Date.now());
    // A shared room link stays useful after all combat seats are claimed.
    return seated.ok ? seated : seated.code === 409 ? { ok: true as const, value: null } : seated;
  });

  if (!outcome.ok) return jsonError(outcome.error, outcome.code);

  // A filled room should no longer be offered to quick-match callers.
  if (!outcome.state.open) await dequeueRoom(outcome.state.mode, roomId);

  const spectating = outcome.value === null;
  const sessionToken = spectating && !isSpectatorToken(token) ? newSpectatorToken() : token;
  return Response.json(
    { roomId, token: sessionToken, side: outcome.value, spectating, view: viewFor(outcome.state, outcome.value) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
