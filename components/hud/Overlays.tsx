'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { SeatView, Side, Team } from '@/lib/game/match';
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

export function FatalOverlay({ message, onNicknameSubmit }: { message: string; onNicknameSubmit?: (name: string) => void }) {
  const [name, setName] = useState('');
  const needsNickname = message.toLowerCase().includes('nickname');

  return (
    <Shell label="No signal">
      <h2 className="font-display text-[15px] font-semibold leading-snug tracking-[0.2em] text-parchment">
        NO SIGNAL
      </h2>
      <p className="mt-3 font-mono text-[11px] font-light leading-relaxed tracking-[0.06em] text-parchment/60">
        {message}
      </p>
      {needsNickname && onNicknameSubmit ? (
        <form
          className="mt-5 flex flex-col items-center gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onNicknameSubmit(name.trim());
          }}
        >
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            required
            maxLength={18}
            placeholder="Enter your nickname"
            aria-label="Nickname"
            className="w-full border border-brass/30 bg-abyss/60 px-3 py-2.5 text-center font-mono text-[13px] tracking-[0.1em] text-parchment placeholder:text-parchment/25 focus:border-brass/70 focus:outline-none"
          />
          <Btn type="submit" tone="primary">Join room</Btn>
        </form>
      ) : (
        <Link href="/" className="mt-6 inline-block">
          <Btn>Back to port</Btn>
        </Link>
      )}
    </Shell>
  );
}

export type WaitingOverlayProps = {
  roomCode: string;
  inviteUrl: string;
  onCopy: () => void;
  copied: boolean;
  onCancel: () => void;
};

export function WaitingOverlay({ roomCode, inviteUrl, onCopy, copied, onCancel }: WaitingOverlayProps) {
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
        <Btn onClick={onCancel}>Cancel</Btn>
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

/** A one-time 2v2-only decision. The engine has already selected its recipient. */
export function SpecialMoveOverlay({ foes, onAccept, onDecline }: {
  foes: SeatView[];
  onAccept: (target: Side) => void;
  onDecline: () => void;
}) {
  const eligible = foes.filter((foe) => !foe.eliminated && foe.ships.filter((ship) => !ship.sunk).length >= 2);
  return (
    <Shell label="Special strike available">
      <p className="stencil text-brass">Classified order</p>
      <h2 className="mt-3 font-display text-[22px] font-semibold tracking-[0.15em] text-flare">SCORCHED EARTH</h2>
      <p className="mt-4 font-mono text-[11px] leading-relaxed tracking-[0.06em] text-parchment/70">
        Bomb 50% of your teammate&apos;s board at random. In return, immediately destroy two ships on one enemy fleet.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {eligible.map((foe) => (
          <Btn key={foe.side} tone="primary" onClick={() => onAccept(foe.side)}>
            Strike {foe.name ?? 'enemy'}
          </Btn>
        ))}
        <Btn onClick={onDecline}>Decline</Btn>
      </div>
      <p className="mt-4 font-mono text-[9px] tracking-[0.08em] text-parchment/40">DECLINING PASSES THE OFFER TO THE NEXT COMMANDER&apos;S TURN</p>
    </Shell>
  );
}

/* ------------------------------------------------------------------- lobby ---- */

export type LobbySeat = { name: string; ready: boolean; isYou: boolean };

export type LobbyOverlayProps = {
  roomCode: string;
  inviteUrl: string;
  onCopy: () => void;
  copied: boolean;
  yourTeam: Team | null;
  yourReady: boolean;
  seatsByTeam: Record<Team, LobbySeat[]>;
  canReady: boolean;
  reasonBlocked: string | null;
  onJoinTeam: (team: Team) => void;
  onSetReady: (ready: boolean) => void;
  onCancel: () => void;
};

const TEAM_LABEL: Record<Team, string> = { red: 'Team Red', blue: 'Team Blue' };
const TEAM_TEXT: Record<Team, string> = { red: 'text-scorch', blue: 'text-foam' };
const TEAM_BORDER: Record<Team, string> = { red: 'border-scorch/50', blue: 'border-foam/50' };

function TeamColumn({
  team,
  seats,
  yourTeam,
  onJoin,
}: {
  team: Team;
  seats: LobbySeat[];
  yourTeam: Team | null;
  onJoin: (team: Team) => void;
}) {
  const open = 2 - seats.length;
  return (
    <div className={`flex-1 border px-4 py-3 ${TEAM_BORDER[team]}`}>
      <h3 className={`stencil ${TEAM_TEXT[team]}`}>{TEAM_LABEL[team]}</h3>
      <ul className="mt-2 flex flex-col gap-1.5">
        {seats.map((s) => (
          <li
            key={s.name}
            className={`font-mono text-[11px] tracking-[0.06em] ${s.isYou ? 'text-flare' : 'text-parchment/75'}`}
          >
            {s.name}
            {s.ready ? <span className="ml-1.5 text-brass/70">READY</span> : null}
          </li>
        ))}
        {Array.from({ length: Math.max(0, open) }).map((_, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onJoin(team)}
              disabled={yourTeam === team}
              className="cursor-pointer font-mono text-[11px] tracking-[0.06em] text-parchment/35 hover:text-parchment/70 disabled:cursor-not-allowed"
            >
              OPEN SEAT — join
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 2v2 lobby: pick a team, ready up. Renders over the 3D theater, which stays alive behind it. */
export function LobbyOverlay({
  roomCode,
  inviteUrl,
  onCopy,
  copied,
  yourTeam,
  yourReady,
  seatsByTeam,
  canReady,
  reasonBlocked,
  onJoinTeam,
  onSetReady,
  onCancel,
}: LobbyOverlayProps) {
  const readyCount = seatsByTeam.red.filter((s) => s.ready).length + seatsByTeam.blue.filter((s) => s.ready).length;
  const totalSeats = seatsByTeam.red.length + seatsByTeam.blue.length;

  return (
    <Shell label="Match lobby">
      <h2 className="stencil text-brass">2v2 lobby</h2>
      <p className="mt-3 font-mono text-[26px] leading-none tracking-[0.3em] text-flare">{roomCode}</p>
      <div className="mx-auto my-4 h-px w-[70px] bg-brass/60" />

      <div className="flex gap-3 text-left">
        <TeamColumn team="red" seats={seatsByTeam.red} yourTeam={yourTeam} onJoin={onJoinTeam} />
        <TeamColumn team="blue" seats={seatsByTeam.blue} yourTeam={yourTeam} onJoin={onJoinTeam} />
      </div>

      <p className="mt-4 font-mono text-[10px] tracking-[0.1em] text-parchment/50">
        {readyCount}/{Math.max(totalSeats, 4)} READY
      </p>
      {reasonBlocked ? (
        <p className="mt-2 font-mono text-[10px] tracking-[0.06em] text-[#e8a04a]">{reasonBlocked}</p>
      ) : null}

      <div className="mt-5 flex justify-center gap-2">
        <Btn
          tone="primary"
          onClick={() => onSetReady(!yourReady)}
          disabled={!yourTeam || (!yourReady && !canReady)}
          className={yourReady ? 'border-flare text-flare' : ''}
        >
          {yourReady ? 'Not ready' : 'Ready'}
        </Btn>
        <Btn onClick={onCopy}>{copied ? 'Copied' : 'Copy invite'}</Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
      <p className="mt-3 truncate font-mono text-[10px] tracking-[0.04em] text-parchment/35">{inviteUrl}</p>
    </Shell>
  );
}

/* --------------------------------------------------------------- game over ---- */

export type OverOverlayProps = {
  outcome: 'win' | 'loss';
  shots: number;
  hits: number;
  onRematch: () => void;
  rematchPending: boolean;
  /** Every other seat still relevant to a rematch (excludes yourself). */
  others: { name: string; present: boolean; rematch: boolean }[];
  soloMode: boolean;
  /** 2v2 only: your teammate's own tally. */
  ally: { name: string; shots: number; hits: number } | null;
};

export function OverOverlay({
  outcome,
  shots,
  hits,
  onRematch,
  rematchPending,
  others,
  soloMode,
  ally,
}: OverOverlayProps) {
  const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
  const won = outcome === 'win';
  const anyoneWantsRematch = others.some((o) => o.rematch);
  const allGone = others.length > 0 && others.every((o) => !o.present);

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
      {ally ? (
        <p className="mt-2 font-mono text-[10px] tracking-[0.08em] text-parchment/45">
          {ally.name}: {ally.hits}/{ally.shots} shots
        </p>
      ) : null}

      {!soloMode && anyoneWantsRematch && !rematchPending ? (
        <p className="stencil mt-5 text-flare">A teammate wants a rematch</p>
      ) : null}
      {!soloMode && rematchPending ? (
        <p className="stencil mt-5 animate-sb-pulse text-parchment/60">
          {allGone ? 'Everyone left the theater' : 'Waiting for the rest of the crew'}
        </p>
      ) : null}

      <div className="mt-6 flex justify-center gap-2">
        <Btn tone="primary" onClick={onRematch} disabled={rematchPending || (!soloMode && allGone)}>
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
