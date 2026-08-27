'use client';

import type { SpecialKind } from '@/lib/game/match';

export type TacticalAction = {
  kind: SpecialKind;
  icon: string;
  code: string;
  name: string;
  detail: string;
  available: boolean;
  active: boolean;
  onActivate?: () => void;
};

/** A deliberately prominent, expandable dock for the match's tactical actions. */
export function TacticalActions({ actions }: { actions: TacticalAction[] }) {
  return (
    <section className="pointer-events-auto absolute bottom-24 left-1/2 z-20 w-[min(980px,calc(100vw-2.5rem))] -translate-x-1/2 sm:bottom-6" aria-label="Tactical actions">
      <div className="mx-auto mb-2 flex w-max items-center gap-2 border-x border-brass/35 px-4 py-1">
        <span className="h-px w-6 bg-brass/50" />
        <p className="stencil text-[10px] text-brass">Tactical ordnance</p>
        <span className="h-px w-6 bg-brass/50" />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        {actions.map((action) => (
          <button
            key={action.kind}
            type="button"
            disabled={!action.active}
            aria-disabled={!action.active}
            onClick={action.active ? action.onActivate : undefined}
            title={action.available ? (action.active ? `${action.name}: ready to launch` : `${action.name}: available on your turn`) : `${action.name}: spent`}
            className={[
              'group relative min-h-[72px] overflow-hidden border px-3 py-2 text-left backdrop-blur-md transition duration-200',
              action.available && action.active
                ? 'border-flare bg-[rgba(37,15,6,.82)] shadow-[0_0_28px_rgba(255,122,47,.25)] hover:-translate-y-0.5 hover:bg-[rgba(64,23,7,.9)]'
                : 'border-white/10 bg-[rgba(8,22,28,.48)] text-parchment/25 opacity-55',
              'disabled:pointer-events-none disabled:cursor-not-allowed',
            ].join(' ')}
          >
            {action.available && action.active ? <span className="absolute inset-y-0 left-0 w-[2px] animate-sb-pulse bg-flare" /> : null}
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 grid size-8 shrink-0 place-items-center border font-display text-[19px] ${action.available && action.active ? 'border-flare/70 text-flare' : 'border-white/15 text-parchment/25'}`} aria-hidden="true">
                {action.icon}
              </span>
              <span className="min-w-0">
                <span className="flex items-center justify-between gap-2 font-mono text-[8px] tracking-[0.18em] text-brass/80">
                  <span>{action.code}</span>
                  <span className={action.available && action.active ? 'text-flare' : 'text-parchment/30'}>{action.available ? (action.active ? 'READY' : 'LOCKED') : 'SPENT'}</span>
                </span>
                <span className="mt-0.5 block font-display text-[13px] font-semibold tracking-[0.12em] text-parchment">{action.name}</span>
                <span className="mt-0.5 block truncate font-mono text-[8px] tracking-[0.06em] text-parchment/55">{action.detail}</span>
              </span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
