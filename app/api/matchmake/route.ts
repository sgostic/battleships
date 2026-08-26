import type { NextRequest } from 'next/server';
import { cleanName, join, type Mode, viewFor } from '@/lib/game/match';
import { jsonError, readJson, requiredName } from '@/lib/net/api';
import {
  createRoom,
  dequeueRoom,
  enqueueRoom,
  mutateRoom,
  newPlayerToken,
  saveRoom,
  takeJoinableRoom,
} from '@/lib/net/rooms';

export const dynamic = 'force-dynamic';

/**
 * POST /api/matchmake — sits the caller down at whichever public room of the same
 * mode is already waiting for another seat, otherwise opens one and queues it.
 */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const required = requiredName(body);
  if (required instanceof Response) return required;
  const mode: Mode = body.mode === 'duo' ? 'duo' : 'duel';
  const token = newPlayerToken();
  const name = required;

  try {
    const waiting = await takeJoinableRoom(mode);
    if (waiting) {
      const outcome = await mutateRoom(waiting.id, (state) =>
        join(state, token, cleanName(name, 'b'), Date.now()),
      );
      if (outcome.ok) {
        if (!outcome.state.open) await dequeueRoom(mode, waiting.id);
        return Response.json(
          {
            roomId: waiting.id,
            token,
            side: outcome.value,
            matched: true,
            view: viewFor(outcome.state, outcome.value),
          },
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      // Lost the race for that seat — fall through and host instead.
    }

    const state = await createRoom(mode, { extraShotOnHit: true }, true);
    const seated = join(state, token, cleanName(name, 'a'), Date.now());
    if (!seated.ok) return jsonError(seated.error, seated.code);
    await saveRoom(state);
    await enqueueRoom(mode, state.id);

    return Response.json(
      {
        roomId: state.id,
        token,
        side: seated.value,
        matched: false,
        view: viewFor(state, seated.value),
      },
      { status: 201, headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Matchmaking failed', 500);
  }
}
