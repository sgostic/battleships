import type { NextRequest } from 'next/server';
import { cleanName, join, type Mode, viewFor } from '@/lib/game/match';
import { jsonError, readJson } from '@/lib/net/api';
import { createRoom, enqueueRoom, newPlayerToken, saveRoom } from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/** POST /api/rooms — opens a new match and seats the caller as side A. */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const mode: Mode = body.mode === 'duo' ? 'duo' : 'duel';
  const open = body.open === true;
  const extraShotOnHit = body.extraShotOnHit !== false;

  try {
    const state = await createRoom(mode, { extraShotOnHit }, open);
    const token = newPlayerToken();
    const seated = join(state, token, cleanName(body.name, 'a'), Date.now());
    if (!seated.ok) return jsonError(seated.error, seated.code);

    await saveRoom(state);
    if (open) await enqueueRoom(mode, state.id);

    return Response.json(
      { roomId: state.id, token, side: seated.value, view: viewFor(state, seated.value) },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Could not create the match', 500);
  }
}
