'use client';

import { Btn } from './Btn';

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
