'use client';

import { Btn } from './Btn';

export type DeployBarProps = {
  hint: string;
  canReady: boolean;
  submitting: boolean;
  onRotate: () => void;
  onRandom: () => void;
  onClear: () => void;
  onReady: () => void;
};

export function DeployBar({
  hint,
  canReady,
  submitting,
  onRotate,
  onRandom,
  onClear,
  onReady,
}: DeployBarProps) {
  return (
    <div className="pointer-events-auto absolute bottom-5 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2.5">
      <p className="text-center font-mono text-[10px] font-light leading-normal tracking-[0.14em] text-parchment/60">
        {hint}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Btn onClick={onRotate}>Rotate&nbsp;&nbsp;R</Btn>
        <Btn onClick={onRandom}>Random</Btn>
        <Btn onClick={onClear}>Clear</Btn>
        <Btn tone="primary" onClick={onReady} disabled={!canReady || submitting}>
          {submitting ? 'Sending…' : 'Ready'}
        </Btn>
      </div>
    </div>
  );
}

export function FireBar({ onFire, disabled }: { onFire: () => void; disabled: boolean }) {
  return (
    <div className="pointer-events-auto absolute bottom-5 left-1/2 -translate-x-1/2">
      <Btn
        tone="fire"
        onClick={onFire}
        disabled={disabled}
        className="px-10 py-[15px] text-[12px] tracking-[0.34em]"
      >
        Fire
      </Btn>
    </div>
  );
}


export function TargetReadout({
  label,
  board,
  active,
}: {
  label: string;
  /** Which enemy fleet the cell belongs to — ambiguous once there are two. */
  board?: string | null;
  active: boolean;
}) {
  return (
    <div className="absolute right-5 bottom-5 text-right">
      <p className="stencil mb-1.5 text-brass/75">Target</p>
      <p
        className={[
          'font-mono text-[26px] leading-none tracking-[0.14em]',
          active ? 'text-flare' : 'text-parchment/25',
        ].join(' ')}
      >
        {board ? `${board} · ${label}` : label}
      </p>
      <p className="mt-1.5 font-mono text-[9px] font-light leading-normal tracking-[0.1em] text-parchment/35">
        Drag orbit · Wheel zoom
      </p>
    </div>
  );
}
