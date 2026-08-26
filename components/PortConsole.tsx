'use client';

/**
 * The port: pick a name, then either take a public match, open a private room
 * with a shareable code, join someone else's code, or run the solo drill.
 * Every path here is a POST to an App Router route handler.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Btn } from '@/components/hud/Btn';
import type { Mode } from '@/lib/game/match';
import {
  createRoom,
  quickMatch,
  recallName,
  rememberName,
  rememberSession,
  type Session,
} from '@/lib/net/client';
import { ROOM_CODE_LENGTH } from '@/lib/net/protocol';

type Busy = 'quick' | 'create' | 'join' | null;

/** localStorage is client-only, so read it as an external store rather than
 *  syncing it into state from an effect (which would flash and re-render). */
const nameStore = {
  subscribe: () => () => {},
  getSnapshot: () => recallName(),
  getServerSnapshot: () => '',
};

export function PortConsole() {
  const router = useRouter();
  const storedName = useSyncExternalStore(
    nameStore.subscribe,
    nameStore.getSnapshot,
    nameStore.getServerSnapshot,
  );
  const [typedName, setTypedName] = useState<string | null>(null);
  const name = typedName ?? storedName;
  const setName = setTypedName;
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<Mode>('duel');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [storeWarning, setStoreWarning] = useState<string | null>(null);

  // Surface a misconfigured store here rather than mid-match.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: { hint?: string | null }) => {
        if (!cancelled && data?.hint) setStoreWarning(data.hint);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const enter = useCallback(
    (session: Session) => {
      // Store the seat token first so the match page resumes this seat
      // instead of claiming a second one.
      rememberSession(session.roomId, session.token);
      router.push(`/play/${session.roomId}`);
    },
    [router],
  );

  const run = useCallback(
    async (kind: Exclude<Busy, null>, action: () => Promise<Session>) => {
      setBusy(kind);
      setError(null);
      rememberName(name.trim());
      try {
        enter(await action());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong');
        setBusy(null);
      }
    },
    [enter, name],
  );

  const joinByCode = useCallback(() => {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 4) {
      setError('Enter the room code your opponent sent you');
      return;
    }
    rememberName(name.trim());
    setBusy('join');
    router.push(`/play/${clean}`);
  }, [code, name, router]);

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-16">
      {/* Golden-hour wash behind the console. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_120%,rgba(207,154,106,.35),transparent_60%),radial-gradient(70%_50%_at_50%_0%,rgba(42,111,134,.28),transparent_70%)]"
      />

      <div className="relative w-full max-w-lg animate-sb-fade">
        <header className="text-center">
          <h1 className="font-display text-[30px] font-semibold leading-none tracking-[0.3em] text-parchment sm:text-[38px]">
            SEA BATTLE
          </h1>
          <p className="stencil mt-3 text-brass/85">Naval theater · Golden hour</p>
          <div className="mx-auto mt-5 h-px w-[120px] bg-gradient-to-r from-transparent via-brass/70 to-transparent" />
        </header>

        <section className="mt-8 border border-brass/30 bg-[rgba(7,20,26,.62)] p-6 backdrop-blur-md sm:p-8">
          <label className="block">
            <span className="stencil text-brass">Commander</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={18}
              placeholder="Unnamed"
              className="mt-2 w-full border border-brass/30 bg-abyss/60 px-3 py-2.5 font-mono text-[13px] tracking-[0.1em] text-parchment placeholder:text-parchment/25 focus:border-brass/70 focus:outline-none"
            />
          </label>

          <div className="mt-6 flex justify-center gap-2">
            <Btn
              tone={mode === 'duel' ? 'primary' : 'default'}
              onClick={() => setMode('duel')}
              disabled={busy !== null}
              className="flex-1"
            >
              1v1
            </Btn>
            <Btn
              tone={mode === 'duo' ? 'primary' : 'default'}
              onClick={() => setMode('duo')}
              disabled={busy !== null}
              className="flex-1"
            >
              2v2
            </Btn>
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <Btn
              tone="primary"
              onClick={() => void run('quick', () => quickMatch(name, mode))}
              disabled={busy !== null}
              className="w-full py-3.5 text-[10.5px]"
            >
              {busy === 'quick' ? 'Finding an opponent…' : 'Quick match'}
            </Btn>
            <Btn
              onClick={() => void run('create', () => createRoom(name, { mode }))}
              disabled={busy !== null}
              className="w-full py-3.5 text-[10.5px]"
            >
              {busy === 'create' ? 'Opening room…' : `Create private room${mode === 'duo' ? ' (2v2)' : ''}`}
            </Btn>
          </div>

          <div className="mt-7 flex items-center gap-3">
            <div className="h-px flex-1 bg-brass/20" />
            <span className="stencil text-parchment/35">Or join a code</span>
            <div className="h-px flex-1 bg-brass/20" />
          </div>

          <div className="mt-4 flex gap-2">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') joinByCode();
              }}
              maxLength={ROOM_CODE_LENGTH + 2}
              placeholder="ABC123"
              aria-label="Room code"
              className="min-w-0 flex-1 border border-brass/30 bg-abyss/60 px-3 py-2.5 font-mono text-[15px] tracking-[0.3em] text-flare uppercase placeholder:text-parchment/20 focus:border-brass/70 focus:outline-none"
            />
            <Btn onClick={joinByCode} disabled={busy !== null} className="shrink-0 px-5">
              {busy === 'join' ? 'Joining…' : 'Join'}
            </Btn>
          </div>

          <div className="mt-7 border-t border-brass/15 pt-5 text-center">
            <Btn onClick={() => router.push('/solo')} disabled={busy !== null}>
              Solo drill vs the machine
            </Btn>
          </div>

          {error ? (
            <p className="mt-5 border border-scorch/50 bg-[rgba(30,10,8,.6)] px-3 py-2 font-mono text-[10px] tracking-[0.08em] text-[#ffb9a0]">
              {error}
            </p>
          ) : null}
        </section>

        <footer className="mt-6 text-center">
          <p className="font-mono text-[9px] leading-relaxed tracking-[0.14em] text-parchment/30">
            Drag to orbit · Wheel to zoom · R rotates · Space fires
          </p>
          {storeWarning ? (
            <p className="mx-auto mt-4 max-w-md border border-brass/25 px-3 py-2 font-mono text-[9px] leading-relaxed tracking-[0.06em] text-brass/70">
              {storeWarning}
            </p>
          ) : null}
        </footer>
      </div>
    </main>
  );
}
