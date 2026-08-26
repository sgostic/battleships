/** Board + fleet rules shared by the browser and the authoritative server. */

export const BOARD = 10;
export const CELLS = BOARD * BOARD;

export type Orient = 'H' | 'V';
export type ShipKey = 'carrier' | 'battleship' | 'cruiser' | 'submarine' | 'destroyer';

export type ShipDef = { key: ShipKey; name: string; len: number };

export const SHIP_DEFS: readonly ShipDef[] = [
  { key: 'carrier', name: 'Carrier', len: 5 },
  { key: 'battleship', name: 'Battleship', len: 4 },
  { key: 'cruiser', name: 'Cruiser', len: 3 },
  { key: 'submarine', name: 'Submarine', len: 3 },
  { key: 'destroyer', name: 'Destroyer', len: 2 },
];

export const FLEET_SIZE = SHIP_DEFS.length;

/** A ship the owner has committed to the board. */
export type Placement = { key: ShipKey; orient: Orient; cells: number[] };

export function defFor(key: ShipKey): ShipDef | undefined {
  return SHIP_DEFS.find((d) => d.key === key);
}

/** "A1" .. "J10" — column letter from the x axis, 1-based row from the y axis. */
export function cellName(i: number): string {
  return 'ABCDEFGHIJ'[i % BOARD] + (Math.floor(i / BOARD) + 1);
}

/** Cells a ship of `len` would occupy anchored at `idx`, or null if it runs off the board. */
export function cellsFor(idx: number, len: number, orient: Orient): number[] | null {
  if (!Number.isInteger(idx) || idx < 0 || idx >= CELLS) return null;
  const c = idx % BOARD;
  const r = Math.floor(idx / BOARD);
  const out: number[] = [];
  for (let k = 0; k < len; k++) {
    const cc = orient === 'H' ? c + k : c;
    const rr = orient === 'H' ? r : r + k;
    if (cc >= BOARD || rr >= BOARD) return null;
    out.push(rr * BOARD + cc);
  }
  return out;
}

/** Ships may touch but never overlap — same rule the original scene enforced. */
export function overlaps(cells: number[], taken: Set<number>): boolean {
  return cells.some((c) => taken.has(c));
}

export type FleetCheck = { ok: true; fleet: Placement[] } | { ok: false; error: string };

/**
 * Validates an untrusted fleet: exactly one of every ship, in-bounds contiguous
 * cells matching the declared orientation and length, and no overlaps.
 */
export function validateFleet(input: unknown): FleetCheck {
  if (!Array.isArray(input)) return { ok: false, error: 'Fleet must be an array' };
  if (input.length !== FLEET_SIZE) return { ok: false, error: `Fleet must contain ${FLEET_SIZE} ships` };

  const taken = new Set<number>();
  const seen = new Set<ShipKey>();
  const fleet: Placement[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'Malformed ship entry' };
    const { key, orient, cells } = raw as Partial<Placement>;
    const def = key ? defFor(key) : undefined;
    if (!def) return { ok: false, error: `Unknown ship "${String(key)}"` };
    if (seen.has(def.key)) return { ok: false, error: `Duplicate ship "${def.key}"` };
    if (orient !== 'H' && orient !== 'V') return { ok: false, error: `Bad orientation for ${def.key}` };
    if (!Array.isArray(cells) || cells.length !== def.len) {
      return { ok: false, error: `${def.name} must cover ${def.len} cells` };
    }
    const expected = cellsFor(cells[0], def.len, orient);
    if (!expected || expected.some((c, i) => c !== cells[i])) {
      return { ok: false, error: `${def.name} is not a valid ${orient === 'H' ? 'horizontal' : 'vertical'} run` };
    }
    if (overlaps(expected, taken)) return { ok: false, error: `${def.name} overlaps another ship` };
    expected.forEach((c) => taken.add(c));
    seen.add(def.key);
    fleet.push({ key: def.key, orient, cells: expected });
  }
  return { ok: true, fleet };
}

/** Random legal fleet — used by the RANDOM button and by the solo opponent. */
export function randomFleet(rng: () => number = Math.random): Placement[] {
  for (let attempt = 0; attempt < 60; attempt++) {
    const taken = new Set<number>();
    const fleet: Placement[] = [];
    let stuck = false;
    for (const def of SHIP_DEFS) {
      let placed = false;
      for (let t = 0; t < 500; t++) {
        const orient: Orient = rng() < 0.5 ? 'H' : 'V';
        const cells = cellsFor(Math.floor(rng() * CELLS), def.len, orient);
        if (!cells || overlaps(cells, taken)) continue;
        cells.forEach((c) => taken.add(c));
        fleet.push({ key: def.key, orient, cells });
        placed = true;
        break;
      }
      if (!placed) { stuck = true; break; }
    }
    if (!stuck) return fleet;
  }
  throw new Error('Could not generate a legal fleet');
}
