import type { FleetSummary } from '@/lib/game/match';
import type { ShipKey } from '@/lib/game/rules';
import { ShipSilhouette } from './ShipSilhouette';

export type FleetPanelProps = {
  title: string;
  ships: FleetSummary[];
  /** Your own panel gets the deployment checklist treatment. */
  mine: boolean;
  deploying: boolean;
  /** Ship currently in hand during deployment. */
  selected?: ShipKey | null;
  placed?: ShipKey[];
  align?: 'left' | 'right';
  onSelect?: (key: ShipKey) => void;
  /** Header rule tint — set for a 2v2 roster so each panel reads by team. */
  team?: 'red' | 'blue' | null;
  /** Squeezes the roster into a single row of silhouettes — for the second
   *  and third panels once there are more than two fleets on screen. */
  compact?: boolean;
};

function pip(
  ship: FleetSummary,
  mine: boolean,
  deploying: boolean,
  selected: ShipKey | null,
  placed: ShipKey[],
): string {
  if (ship.sunk) return 'SUNK';
  if (mine && deploying) {
    if (placed.includes(ship.key)) return '✓';
    return selected === ship.key ? '▸' : '';
  }
  if (ship.hits) return `${ship.hits}/${ship.len}`;
  return mine ? '' : '—';
}

const TEAM_RULE: Record<'red' | 'blue', string> = {
  red: 'border-scorch/60',
  blue: 'border-foam/60',
};

export function FleetPanel({
  title,
  ships,
  mine,
  deploying,
  selected = null,
  placed = [],
  align = 'left',
  onSelect,
  team = null,
  compact = false,
}: FleetPanelProps) {
  const alive = ships.filter((s) => !s.sunk).length;

  if (compact) {
    return (
      <section
        className={[
          'w-[196px] border-t-2 bg-[rgba(7,20,26,.55)] px-3 py-2 backdrop-blur-md',
          team ? TEAM_RULE[team] : 'border-brass/30',
        ].join(' ')}
        aria-label={title}
      >
        <header className="mb-1.5 flex items-baseline justify-between">
          <h2 className="stencil text-brass">{title}</h2>
          <span className="font-mono text-[9px] text-parchment/40">{alive}/{ships.length}</span>
        </header>
        <div className={`flex gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
          {ships.map((ship) => (
            <div key={ship.key} className="scale-[0.72]" title={ship.name}>
              <ShipSilhouette shipKey={ship.key} sunk={ship.sunk} />
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      className={[
        'w-[196px] border bg-[rgba(7,20,26,.55)] px-3 pt-3 pb-2 backdrop-blur-md',
        team ? `${TEAM_RULE[team]} border-t-2` : 'border-brass/30',
      ].join(' ')}
      aria-label={title}
    >
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="stencil text-brass">{title}</h2>
        <span className="font-mono text-[9px] text-parchment/40">{alive}/{ships.length}</span>
      </header>

      <ul>
        {ships.map((ship) => {
          const isSelected = mine && deploying && selected === ship.key;
          const label = pip(ship, mine, deploying, selected, placed);
          const interactive = Boolean(mine && deploying && onSelect);

          const row = (
            <>
              <ShipSilhouette shipKey={ship.key} sunk={ship.sunk} />
              <span
                className={[
                  'min-w-0 flex-1 font-display text-[11.5px] leading-tight tracking-[0.1em]',
                  ship.sunk
                    ? 'text-parchment/30 line-through decoration-[rgba(200,80,50,.8)]'
                    : isSelected
                      ? 'font-semibold text-flare'
                      : 'text-parchment/90',
                  align === 'right' ? 'text-right' : '',
                ].join(' ')}
              >
                {ship.name}
              </span>
              <span
                className={[
                  'shrink-0 font-mono text-[8.5px] tracking-[0.14em]',
                  ship.sunk ? 'text-[rgba(200,80,50,.9)]' : ship.hits ? 'text-[#e08a4a]' : 'text-brass/65',
                ].join(' ')}
              >
                {label}
              </span>
            </>
          );

          return (
            <li key={ship.key} className="border-t border-brass/15">
              {interactive ? (
                <button
                  type="button"
                  onClick={() => onSelect?.(ship.key)}
                  className="flex w-full cursor-pointer items-center gap-[9px] py-[7px] text-left hover:bg-brass/5"
                >
                  {row}
                </button>
              ) : (
                <div className="flex items-center gap-[9px] py-[7px]">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
