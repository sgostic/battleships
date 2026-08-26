'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useSyncExternalStore } from 'react';
import { GameShell } from '@/components/GameShell';
import { forgetSession, leaveRoom } from '@/lib/net/client';
import { useOnlineMatch } from '@/lib/net/useOnlineMatch';

/** The page origin is browser-only, so read it as an external store. */
const originStore = {
  subscribe: () => () => {},
  getSnapshot: () => window.location.origin,
  getServerSnapshot: () => '',
};

/** An online 1v1 seat. All state comes from the room's route handlers. */
export function OnlineGame({ roomId }: { roomId: string }) {
  const router = useRouter();
  const match = useOnlineMatch(roomId);
  const origin = useSyncExternalStore(
    originStore.subscribe,
    originStore.getSnapshot,
    originStore.getServerSnapshot,
  );

  const inviteUrl = origin ? `${origin}/play/${roomId}` : `/play/${roomId}`;

  // Leaving is explicit. A refresh or a dropped connection keeps the seat, so
  // reloading mid-battle resumes instead of forfeiting.
  const leave = useCallback(() => {
    if (match.token) leaveRoom(roomId, match.token);
    forgetSession(roomId);
    router.push('/');
  }, [match.token, roomId, router]);

  return <GameShell adapter={match} fatal={match.fatal} inviteUrl={inviteUrl} onLeave={leave} />;
}
