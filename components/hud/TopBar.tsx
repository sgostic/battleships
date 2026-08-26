'use client';

import type { Side, Team } from '@/lib/game/match';
import { Btn } from './Btn';

export type TurnChip = {
  side: Side;
  name: string;
  team: Team | null;
  isYou: boolean;
  acting: boolean;
  eliminated: boolean;
};

const TEAM_DOT: Record<Team, string> = { red: 'bg-scorch', blue: 'bg-foam' };

/** The four-seat rotation strip. A no-op (renders nothing) for duel/solo. */
function TurnStrip({ chips }: { chips: TurnChip[] }) {
  if (chips.length < 3) return null;
  return (
    <ol className="pointer-events-none flex items-center gap-1.5">
      {chips.map((c, i) => (
        <li key={c.side} className="flex items-center gap-1.5">
          {i > 0 ? <span className="text-parchment/25">›</span> : null}
          <span
            className={[
              'flex items-center gap-1 border-l-2 px-1.5 py-0.5 font-mono text-[8.5px] tracking-[0.08em]',
              c.team === 'red' ? 'border-scorch' : 'border-foam',
              c.acting ? 'bg-[rgba(255,217,160,.12)] text-flare' : 'text-parchment/55',
              c.eliminated ? 'text-parchment/25 line-through' : '',
            ].join(' ')}
          >
            <span className={`size-1.5 shrink-0 rounded-full ${c.team ? TEAM_DOT[c.team] : 'bg-parchment/40'}`} />
            {c.isYou ? 'YOU' : c.name.toUpperCase().slice(0, 10)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export type TopBarProps = {
  turnLabel: string;
  phaseLabel: string;
  urgent: boolean;
  muted: boolean;
  onToggleMute: () => void;
  roomCode?: string | null;
  opponent?: string | null;
  onCopyInvite?: () => void;
  copied?: boolean;
  onLeave?: () => void;
  turnChips?: TurnChip[];
};

export function TopBar({
  turnLabel,
  phaseLabel,
  urgent,
  muted,
  onToggleMute,
  roomCode,
  opponent,
  onCopyInvite,
  copied,
  onLeave,
  turnChips = [],
}: TopBarProps) {
  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 bg-gradient-to-b from-[rgba(6,18,24,.62)] to-transparent px-5 pt-4 pb-6">
      <div>
        <h1 className="font-display text-[19px] font-semibold leading-none tracking-[0.3em] text-parchment">
          SEA BATTLE
        </h1>
        <p className="stencil mt-1.5 text-brass/85">
          {roomCode ? `Room ${roomCode}` : 'Naval theater · Golden hour'}
        </p>
        {opponent ? (
          <p className="stencil mt-1 text-parchment/40">VS {opponent}</p>
        ) : null}
      </div>

      <div className="flex flex-col items-center gap-1.5 pt-0.5">
        <div className="h-px w-[120px] bg-gradient-to-r from-transparent via-brass/70 to-transparent" />
        <p
          className={[
            'font-display text-[12px] font-semibold leading-none tracking-[0.28em] py-0.5',
            urgent ? 'animate-sb-pulse text-[#e8a04a]' : 'text-parchment',
          ].join(' ')}
        >
          {turnLabel}
        </p>
        <p className="stencil text-parchment/45">{phaseLabel}</p>
        <TurnStrip chips={turnChips} />
      </div>

      <div className="pointer-events-auto flex items-center gap-2">
        {onCopyInvite ? (
          <Btn onClick={onCopyInvite}>{copied ? 'Link copied' : 'Invite'}</Btn>
        ) : null}
        {onLeave ? <Btn onClick={onLeave}>Leave</Btn> : null}
        <Btn
          onClick={onToggleMute}
          aria-pressed={!muted}
          className={muted ? 'border-brass/35 text-parchment/50' : 'border-brass/75 text-flare'}
        >
          {muted ? 'Sound off' : 'Sound on'}
        </Btn>
      </div>
    </header>
  );
}
