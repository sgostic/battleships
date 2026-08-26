'use client';

/**
 * Online adapter: claims a seat, then keeps a long-poll open against
 * `GET /api/rooms/:id`. Every online interaction is a plain App Router route
 * handler call — no sockets, no third-party realtime service.
 *
 * The seat token lives in localStorage, so a refresh resumes the same seat
 * instead of forfeiting the match.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchAdapter } from '../game/adapter';
import type { MatchView, Side, Team } from '../game/match';
import type { Placement } from '../game/rules';
import {
  ApiError,
  claimSeat,
  fetchView,
  postDeploy,
  postChat,
  postFire,
  postAutoFire,
  postReady,
  postRematch,
  postSpecialMove,
  postTeam,
  recallName,
  releaseClaim,
} from './client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type OnlineMatch = MatchAdapter & {
  /** Set when the room cannot be entered at all (missing, full, expired). */
  fatal: string | null;
  token: string | null;
  retry: () => void;
};

export function useOnlineMatch(roomId: string): OnlineMatch {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<MatchView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const versionRef = useRef(-1);

  const ingest = useCallback((next: MatchView) => {
    versionRef.current = next.version;
    setView(next);
  }, []);

  /* ---- claim (or resume) a seat -------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const session = await claimSeat(roomId, recallName());
        if (cancelled) return;
        setToken(session.token);
        ingest(session.view);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not join the match';
        setFatal(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId, attempt, ingest]);

  /* ---- long-poll for the opponents' moves ---------------------------------- */

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let stopped = false;

    (async () => {
      while (!stopped) {
        try {
          const next = await fetchView({
            roomId,
            token,
            since: 0,
            version: versionRef.current,
            wait: true,
            signal: controller.signal,
          });
          if (stopped) break;
          ingest(next);
          setError(null);
        } catch (err) {
          if (stopped || controller.signal.aborted) break;
          if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
            setFatal(err.message);
            break;
          }
          setError(err instanceof Error ? err.message : 'Connection lost');
          await sleep(2500);
        }
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
    };
  }, [roomId, token, ingest]);

  /* ---- actions ------------------------------------------------------------- */

  const guard = useCallback(
    async (run: (token: string) => Promise<MatchView>) => {
      if (!token) return;
      try {
        ingest(await run(token));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That move was rejected');
      }
    },
    [token, ingest],
  );

  const deploy = useCallback(
    (fleet: Placement[]) => guard((t) => postDeploy(roomId, t, fleet, 0)),
    [guard, roomId],
  );
  const fire = useCallback(
    (target: Side, idx: number) => guard((t) => postFire(roomId, t, target, idx, 0)),
    [guard, roomId],
  );
  const respondSpecialMove = useCallback(
    (accept: boolean, target?: Side) => guard((t) => postSpecialMove(roomId, t, accept, target, 0)),
    [guard, roomId],
  );
  useEffect(() => {
    if (!view || view.phase !== 'battle' || view.turn !== view.you || view.turnStartedAt === null) return;
    if (view.specialMoveOffer) {
      const expiresAt = view.specialMoveExpiresAt ?? Date.now() + 20_000;
      const timer = window.setTimeout(
        () => void respondSpecialMove(false),
        Math.max(0, expiresAt - Date.now() + 100),
      );
      return () => window.clearTimeout(timer);
    }
    // Add a small grace period for clock skew between the browser and server.
    const timer = window.setTimeout(() => void guard((t) => postAutoFire(roomId, t, 0)), Math.max(0, view.turnStartedAt + 12_000 - Date.now() + 500));
    return () => window.clearTimeout(timer);
  }, [guard, respondSpecialMove, roomId, view]);
  const setTeam = useCallback(
    (team: Team | null) => guard((t) => postTeam(roomId, t, team, 0)),
    [guard, roomId],
  );
  const setReady = useCallback(
    (ready: boolean) => guard((t) => postReady(roomId, t, ready, 0)),
    [guard, roomId],
  );
  const rematch = useCallback(() => guard((t) => postRematch(roomId, t, 0)), [guard, roomId]);
  const sendChat = useCallback((text: string) => guard((t) => postChat(roomId, t, text, 0)), [guard, roomId]);

  return {
    mode: 'online',
    roomId,
    view,
    connected: view !== null,
    error,
    fatal,
    token,
    clearError: () => setError(null),
    deploy,
    fire,
    respondSpecialMove,
    setTeam,
    setReady,
    rematch,
    sendChat,
    retry: () => {
      releaseClaim(roomId);
      setFatal(null);
      setAttempt((n) => n + 1);
    },
  };
}
