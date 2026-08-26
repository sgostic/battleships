/**
 * The little top-down ship profiles in the fleet panels, ported from the
 * original's CSS silhouettes. Geometry stays inline because it is per-ship
 * pixel work; colour and layout come from Tailwind.
 */

import type { CSSProperties } from 'react';
import type { ShipKey } from '@/lib/game/rules';

type Part = { left: number; top: number; width: number; height: number; clip?: string };

const HULL_CLIP = 'polygon(0 0,88% 0,100% 55%,92% 100%,4% 100%)';
const SUB_CLIP = 'polygon(0 40%,6% 0,94% 0,100% 45%,94% 100%,6% 100%)';

const hull = (width: number): Part => ({
  left: 52 - width,
  top: 8,
  width,
  height: 5,
  clip: HULL_CLIP,
});

const PARTS: Record<ShipKey, Part[]> = {
  carrier: [
    hull(52),
    { left: 24, top: 4, width: 16, height: 4 },
    { left: 30, top: 1, width: 5, height: 4 },
  ],
  battleship: [
    hull(44),
    { left: 22, top: 3, width: 12, height: 5 },
    { left: 26, top: 0, width: 4, height: 4 },
    { left: 15, top: 4, width: 5, height: 4 },
    { left: 36, top: 5, width: 5, height: 3 },
  ],
  cruiser: [
    hull(36),
    { left: 26, top: 4, width: 9, height: 4 },
    { left: 30, top: 1, width: 3, height: 4 },
    { left: 20, top: 3, width: 4, height: 5 },
  ],
  submarine: [
    { left: 14, top: 9, width: 38, height: 4, clip: SUB_CLIP },
    { left: 30, top: 5, width: 10, height: 4 },
    { left: 34, top: 1, width: 2, height: 5 },
  ],
  destroyer: [
    hull(28),
    { left: 34, top: 4, width: 8, height: 4 },
    { left: 38, top: 1, width: 3, height: 4 },
    { left: 30, top: 4, width: 3, height: 5 },
  ],
};

export function ShipSilhouette({ shipKey, sunk }: { shipKey: ShipKey; sunk: boolean }) {
  const background = sunk ? 'rgba(242,228,201,.22)' : 'rgba(242,228,201,.72)';
  return (
    <div className="relative h-[15px] w-[52px] shrink-0" aria-hidden>
      {PARTS[shipKey].map((p, i) => {
        const style: CSSProperties = {
          left: p.left,
          top: p.top,
          width: p.width,
          height: p.height,
          background,
          clipPath: p.clip,
        };
        return <div key={i} className="absolute" style={style} />;
      })}
    </div>
  );
}
