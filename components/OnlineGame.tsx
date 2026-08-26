'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
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
  const leftRef = useRef(false);
  const origin = useSyncExternalStore(
    originStore.subscribe,
    originStore.getSnapshot,
    originStore.getServerSnapshot,
  );

  const inviteUrl = origin ? `${origin}/play/${roomId}` : `/play/${roomId}`;

  // A tab closing does not run the React cleanup reliably. pagehide is the
  // browser lifecycle event intended for this case, and leaveRoom uses a
  // keepalive request so the server can persist the seat removal while the
  // document is being torn down.
  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      // Keep a page entering the back/forward cache resumable.
      if (event.persisted) return;
      if (leftRef.current || !match.token) return;
      leftRef.current = true;
      leaveRoom(roomId, match.token);
    };

    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, [match.token, roomId]);

  // Leaving is explicit. A refresh or a dropped connection keeps the seat, so
  // reloading mid-battle resumes instead of forfeiting.
  const leave = useCallback(() => {
    if (match.token && !leftRef.current) {
      leftRef.current = true;
      leaveRoom(roomId, match.token);
    }
    forgetSession(roomId);
    router.push('/');
  }, [match.token, roomId, router]);

  return <GameShell adapter={match} fatal={match.fatal} inviteUrl={inviteUrl} onLeave={leave} />;
}
