'use client';

/** Solo drill: the same match machine the server runs, with an AI in seat B. */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchAdapter } from './adapter';
import { type AiLevel, type AiMemory, aiObserve, aiPick, newAiMemory } from './ai';
import {
  type MatchState,
  type MatchView,
  type Side,
  createMatch,
  deploy as deployFleetTo,
  fire as fireAt,
  join,
  requestRematch,
  viewFor,
} from './match';
import { type Placement, randomFleet } from './rules';

const YOU = 'solo-you';
const FOE = 'solo-ai';
const YOU_SIDE: Side = 'a';
const FOE_SIDE: Side = 'b';

export function useSoloMatch(level: AiLevel = 'Officer'): MatchAdapter {
  const stateRef = useRef<MatchState | null>(null);
  const memoryRef = useRef<AiMemory>(newAiMemory());
  const [view, setView] = useState<MatchView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback(() => {
    const state = stateRef.current;
    if (state) setView(viewFor(state, YOU_SIDE));
  }, []);

  /** Runs the AI until the turn comes back to the player. */
  const runOpponent = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    let guard = 0;
    while (state.phase === 'battle' && state.turn === FOE_SIDE && guard++ < 120) {
      const incoming = state.players[YOU_SIDE]?.incoming;
      if (!incoming) break;
      const pick = aiPick(memoryRef.current, incoming, level);
      if (pick === null) break;
      const before = state.eventSeq;
      const res = fireAt(state, FOE_SIDE, YOU_SIDE, pick, Date.now());
      if (!res.ok) break;
      const shot = state.events.find((e) => e.seq === before + 1);
      if (shot?.type === 'shot') {
        aiObserve(memoryRef.current, pick, shot.hit, Boolean(shot.sunk), incoming, level);
      }
    }
  }, [level]);

  const start = useCallback(() => {
    const now = Date.now();
    const state = createMatch('SOLO', now, 'duel', { extraShotOnHit: true });
    join(state, YOU, 'You', now);
    join(state, FOE, 'Fleet Command', now);
    deployFleetTo(state, FOE_SIDE, randomFleet(), now);
    stateRef.current = state;
    memoryRef.current = newAiMemory();
    publish();
  }, [publish]);

  useEffect(() => {
    start();
  }, [start]);

  const deploy = useCallback(
    async (fleet: Placement[]) => {
      const state = stateRef.current;
      if (!state) return;
      const res = deployFleetTo(state, YOU_SIDE, fleet, Date.now());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      publish();
    },
    [publish],
  );

  const fire = useCallback(
    async (target: Side, idx: number) => {
      const state = stateRef.current;
      if (!state) return;
      const res = fireAt(state, YOU_SIDE, target, idx, Date.now());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      runOpponent();
      publish();
    },
    [publish, runOpponent],
  );

  const rematch = useCallback(async () => {
    const state = stateRef.current;
    if (!state) return;
    const now = Date.now();
    requestRematch(state, YOU_SIDE, now);
    const res = requestRematch(state, FOE_SIDE, now);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    deployFleetTo(state, FOE_SIDE, randomFleet(), now);
    memoryRef.current = newAiMemory();
    publish();
  }, [publish]);

  return {
    mode: 'solo',
    roomId: null,
    view,
    connected: view !== null,
    error,
    clearError: () => setError(null),
    deploy,
    fire,
    rematch,
  };
}
