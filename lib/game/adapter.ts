/**
 * The contract between the game shell and whatever is running the match.
 *
 * Online play talks to the route handlers; solo play runs the identical state
 * machine in the browser. The shell cannot tell the difference.
 */

import type { MatchView, Side, Team } from './match';
import type { Placement } from './rules';

export type MatchAdapter = {
  mode: 'online' | 'solo';
  roomId: string | null;
  /** Latest snapshot from the authority. A new object means "something changed". */
  view: MatchView | null;
  /** True once a seat is held and the first snapshot has arrived. */
  connected: boolean;
  error: string | null;
  clearError: () => void;
  deploy: (fleet: Placement[]) => Promise<void>;
  fire: (target: Side, idx: number) => Promise<void>;
  respondSpecialMove?: (accept: boolean, target?: Side) => Promise<void>;
  rematch: () => Promise<void>;
  sendChat?: (text: string) => Promise<void>;
  /** Lobby-only. Absent when the match has no team/ready step (solo, duel). */
  setTeam?: (team: Team | null) => Promise<void>;
  setReady?: (ready: boolean) => Promise<void>;
};
