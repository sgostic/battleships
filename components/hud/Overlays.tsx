'use client';

import Link from 'next/link';
import { Btn } from './Btn';

function Shell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="pointer-events-auto absolute inset-0 flex animate-sb-fade items-center justify-center bg-[rgba(5,14,19,.72)] px-6 backdrop-blur-[3px]"
    >
      <div className="w-[min(460px,88vw)] border border-brass/40 bg-[rgba(8,22,28,.9)] px-8 pt-8 pb-7 text-center">
        {children}
      </div>
    </div>
  );
}

export function FatalOverlay({ message }: { message: string }) {
  return (
    <Shell label="No signal">
      <h2 className="font-display text-[15px] font-semibold leading-snug tracking-[0.2em] text-parchment">
        NO SIGNAL
      </h2>
      <p className="mt-3 font-mono text-[11px] font-light leading-relaxed tracking-[0.06em] text-parchment/60">
        {message}
      </p>
      <Link href="/" className="mt-6 inline-block">
        <Btn>Back to port</Btn>
      </Link>
    </Shell>
  );
}

export type WaitingOverlayProps = {
  roomCode: string;
  inviteUrl: string;
  onCopy: () => void;
  copied: boolean;
};

export function WaitingOverlay({ roomCode, inviteUrl, onCopy, copied }: WaitingOverlayProps) {
  return (
    <Shell label="Awaiting challenger">
      <h2 className="stencil text-brass">Awaiting challenger</h2>
      <p className="mt-4 font-mono text-[38px] leading-none tracking-[0.3em] text-flare">
        {roomCode}
      </p>
      <div className="mx-auto my-5 h-px w-[70px] bg-brass/60" />
      <p className="font-mono text-[11px] font-light leading-relaxed tracking-[0.08em] text-parchment/60">
        Send the code, or the link below, to the commander you want to face.
      </p>
      <p className="mt-3 truncate font-mono text-[10px] tracking-[0.04em] text-parchment/35">
        {inviteUrl}
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Btn tone="primary" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy invite'}
        </Btn>
        <Link href="/">
          <Btn>Cancel</Btn>
        </Link>
      </div>
    </Shell>
  );
}

export function StandbyOverlay({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 animate-sb-fade border border-brass/30 bg-[rgba(8,22,28,.82)] px-5 py-3 backdrop-blur-md">
      <p className="stencil animate-sb-pulse text-parchment/70">{message}</p>
    </div>
  );
}

export type OverOverlayProps = {
  outcome: 'win' | 'loss';
  shots: number;
  hits: number;
  onRematch: () => void;
  rematchPending: boolean;
  opponentWantsRematch: boolean;
  opponentPresent: boolean;
  soloMode: boolean;
};

export function OverOverlay({
  outcome,
  shots,
  hits,
  onRematch,
  rematchPending,
  opponentWantsRematch,
  opponentPresent,
  soloMode,
}: OverOverlayProps) {
  const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
  const won = outcome === 'win';

  return (
    <Shell label={won ? 'Victory' : 'Defeat'}>
      <h2
        className={[
          'font-display text-[30px] font-semibold leading-none tracking-[0.3em]',
          won ? 'text-flare' : 'text-[#e07a52]',
        ].join(' ')}
      >
        {won ? 'VICTORY' : 'DEFEAT'}
      </h2>
      <div className="mx-auto my-[18px] h-px w-[70px] bg-brass/60" />
      <dl className="font-mono text-[12px] leading-[1.9] tracking-[0.1em] text-parchment/70">
        <div className="flex justify-center gap-2">
          <dt>SHOTS FIRED</dt>
          <dd>{shots}</dd>
        </div>
        <div className="flex justify-center gap-2">
          <dt>HITS</dt>
          <dd>{hits}</dd>
        </div>
        <div className="flex justify-center gap-2">
          <dt>ACCURACY</dt>
          <dd>{accuracy}%</dd>
        </div>
      </dl>

      {!soloMode && opponentWantsRematch && !rematchPending ? (
        <p className="stencil mt-5 text-flare">Opponent wants a rematch</p>
      ) : null}
      {!soloMode && rematchPending ? (
        <p className="stencil mt-5 animate-sb-pulse text-parchment/60">
          {opponentPresent ? 'Waiting for opponent' : 'Opponent left the theater'}
        </p>
      ) : null}

      <div className="mt-6 flex justify-center gap-2">
        <Btn tone="primary" onClick={onRematch} disabled={rematchPending || (!soloMode && !opponentPresent)}>
          Rematch
        </Btn>
        <Link href="/">
          <Btn>Back to port</Btn>
        </Link>
      </div>
    </Shell>
  );
}

export function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="pointer-events-auto absolute top-24 left-1/2 flex -translate-x-1/2 animate-sb-rise items-center gap-3 border border-scorch/60 bg-[rgba(30,10,8,.88)] px-4 py-2.5 backdrop-blur-md">
      <p className="font-mono text-[10px] tracking-[0.1em] text-[#ffb9a0]">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="cursor-pointer font-mono text-[11px] text-parchment/50 hover:text-parchment"
      >
        ✕
      </button>
    </div>
  );
}
