/**
 * The contract between the game shell and whatever is running the match.
 *
 * Online play talks to the route handlers; solo play runs the identical state
 * machine in the browser. The shell cannot tell the difference.
 */

import type { MatchView } from './match';
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
  fire: (idx: number) => Promise<void>;
  rematch: () => Promise<void>;
};
