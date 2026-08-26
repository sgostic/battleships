/**
 * The solo opponent. Hunts at random on a checkerboard (no ship is smaller than
 * two cells, so half the grid is enough to find everything), then works outwards
 * from a hit. It only ever reads the same information a human player would.
 */

import { BOARD, CELLS } from './rules';
import type { Mark } from './match';

export type AiLevel = 'Cadet' | 'Officer' | 'Admiral';

export type AiMemory = {
  /** Cells queued for follow-up after a hit. */
  queue: number[];
  /** Hits on the ship currently being worked. */
  hits: number[];
};

export function newAiMemory(): AiMemory {
  return { queue: [], hits: [] };
}

/** Chooses a cell that has not been fired at, or null when the board is full. */
export function aiPick(memory: AiMemory, incoming: readonly Mark[], level: AiLevel): number | null {
  const open = (i: number) => incoming[i] === 0;

  if (level !== 'Cadet' && memory.queue.length) {
    memory.queue = memory.queue.filter(open);
    const next = memory.queue.shift();
    if (next !== undefined) return next;
  }

  const all: number[] = [];
  for (let i = 0; i < CELLS; i++) if (open(i)) all.push(i);
  if (!all.length) return null;

  const parity = all.filter((i) => ((i % BOARD) + Math.floor(i / BOARD)) % 2 === 0);
  const pool = level === 'Cadet' || !parity.length ? all : parity;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Feeds the outcome of a shot back into the hunt. */
export function aiObserve(
  memory: AiMemory,
  idx: number,
  hit: boolean,
  sunk: boolean,
  incoming: readonly Mark[],
  level: AiLevel,
): void {
  if (sunk) {
    memory.queue = [];
    memory.hits = [];
    return;
  }
  if (!hit || level === 'Cadet') return;

  const c = idx % BOARD;
  const r = Math.floor(idx / BOARD);
  memory.hits.push(idx);

  let neighbours: [number, number][] = [
    [c - 1, r],
    [c + 1, r],
    [c, r - 1],
    [c, r + 1],
  ];

  // Two hits in a row give away the ship's axis, so stop probing sideways.
  if (level === 'Admiral' && memory.hits.length > 1) {
    const prev = memory.hits[memory.hits.length - 2];
    const sameRow = Math.floor(prev / BOARD) === r;
    neighbours = sameRow
      ? [
          [c - 1, r],
          [c + 1, r],
        ]
      : [
          [c, r - 1],
          [c, r + 1],
        ];
  }

  neighbours.forEach(([x, y]) => {
    if (x < 0 || x >= BOARD || y < 0 || y >= BOARD) return;
    const cell = y * BOARD + x;
    if (incoming[cell] === 0 && !memory.queue.includes(cell)) memory.queue.unshift(cell);
  });
}
