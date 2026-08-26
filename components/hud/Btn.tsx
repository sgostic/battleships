'use client';

import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'default' | 'primary' | 'fire';
};

const TONES = {
  default: 'border-brass/55 text-parchment hover:bg-brass/15',
  primary: 'border-brass text-flare hover:bg-brass/20',
  fire: 'border-ember/80 bg-[rgba(30,12,6,.6)] text-[#ffb277] hover:bg-[rgba(60,20,8,.7)]',
} as const;

/** The stencilled HUD button used across deployment and battle controls. */
export function Btn({ tone = 'default', className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      className={[
        'cursor-pointer border bg-hull/60 px-[15px] py-[9px] font-mono text-[9.5px]',
        'tracking-[0.2em] uppercase backdrop-blur-sm transition-colors',
        'disabled:cursor-not-allowed disabled:border-brass/25 disabled:text-parchment/35 disabled:hover:bg-hull/60',
        TONES[tone],
        className,
      ].join(' ')}
      {...rest}
    />
  );
}
