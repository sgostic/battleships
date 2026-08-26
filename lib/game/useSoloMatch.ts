'use client';

/** Solo drill: the same match machine the server runs, with one or three AI seats. */

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
  respondSpecialMove as respondToSpecialMove,
  setReady,
  setTeam,
  sendChat as sendChatMessage,
  viewFor,
} from './match';
import { type Placement, randomFleet } from './rules';

const YOU = 'solo-you';
const YOU_SIDE: Side = 'a';
const BOT_SIDES: Side[] = ['b', 'c', 'd'];

export function useSoloMatch(level: AiLevel = 'Officer', duo = false): MatchAdapter {
  const stateRef = useRef<MatchState | null>(null);
  const memoryRef = useRef<Record<string, AiMemory>>({});
  const [view, setView] = useState<MatchView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const publish = useCallback(() => {
    const state = stateRef.current;
    if (state) setView(viewFor(state, YOU_SIDE));
  }, []);

  /** Runs every bot turn until the turn comes back to the player. */
  const runOpponent = useCallback(() => {
    const state = stateRef.current;
    if (!state) return;
    let guard = 0;
    while (state.phase === 'battle' && state.turn !== YOU_SIDE && guard++ < 480) {
      const botSide = state.turn;
      if (!botSide || !BOT_SIDES.includes(botSide)) break;
      // Bots always reject the high-risk 2v2 strike in this first iteration.
      if (state.specialMove?.offerSide === botSide) {
        const declined = respondToSpecialMove(state, botSide, false, null, Date.now());
        if (!declined.ok) break;
      }
      const memory = memoryRef.current[botSide] ?? (memoryRef.current[botSide] = newAiMemory());
      const targets = BOT_SIDES.concat(YOU_SIDE).filter((targetSide) => {
        const target = state.players[targetSide];
        return Boolean(target && target.team !== state.players[botSide]?.team && !target.eliminated);
      });
      const targetSide = targets[Math.floor(Math.random() * targets.length)];
      const incoming = targetSide ? state.players[targetSide]?.incoming : null;
      if (!targetSide || !incoming) break;
      const pick = aiPick(memory, incoming, level);
      if (pick === null) break;
      const before = state.eventSeq;
      const res = fireAt(state, botSide, targetSide, pick, Date.now());
      if (!res.ok) break;
      const shot = state.events.find((e) => e.seq === before + 1);
      if (shot?.type === 'shot') {
        aiObserve(memory, pick, shot.hit, Boolean(shot.sunk), incoming, level);
      }
    }
  }, [level]);

  const start = useCallback(() => {
    const now = Date.now();
    const state = createMatch('SOLO', now, duo ? 'duo' : 'duel', { extraShotOnHit: true });
    join(state, YOU, 'You', now);
    if (duo) {
      join(state, 'b', 'Admiral Vale', now);
      join(state, 'c', 'Captain Rook', now);
      join(state, 'd', 'Commander Ash', now);
      ['a', 'c'].forEach((side) => setTeam(state, side as Side, 'red', now));
      ['b', 'd'].forEach((side) => setTeam(state, side as Side, 'blue', now));
      ['a', 'b', 'c', 'd'].forEach((side) => setReady(state, side as Side, true, now));
    } else {
      join(state, 'b', 'Fleet Command', now);
      deployFleetTo(state, 'b', randomFleet(), now);
    }
    stateRef.current = state;
    memoryRef.current = {};
    BOT_SIDES.forEach((side) => {
      if (state.players[side]) deployFleetTo(state, side, randomFleet(), now);
    });
    publish();
  }, [duo, publish]);

  const sendChat = useCallback(async (text: string) => {
    const state = stateRef.current;
    if (!state) return;
    const res = sendChatMessage(state, YOU_SIDE, text, Date.now());
    if (!res.ok) setError(res.error);
    else publish();
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

  const respondSpecialMove = useCallback(async (accept: boolean, target?: Side) => {
    const state = stateRef.current;
    if (!state) return;
    const res = respondToSpecialMove(state, YOU_SIDE, accept, target, Date.now());
    if (!res.ok) setError(res.error);
    else publish();
  }, [publish]);

  const rematch = useCallback(async () => {
    const state = stateRef.current;
    if (!state) return;
    const now = Date.now();
    let res = requestRematch(state, YOU_SIDE, now);
    BOT_SIDES.forEach((side) => {
      if (res.ok && state.players[side]) res = requestRematch(state, side, now);
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    BOT_SIDES.forEach((side) => {
      if (state.players[side]) deployFleetTo(state, side, randomFleet(), now);
    });
    memoryRef.current = {};
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
    respondSpecialMove,
    rematch,
    sendChat,
  };
}
