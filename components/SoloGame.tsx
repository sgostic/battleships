'use client';

import { useRouter } from 'next/navigation';
import { GameShell } from '@/components/GameShell';
import { useSoloMatch } from '@/lib/game/useSoloMatch';

/** Solo drill. Same shell, same rules, opponent runs in this tab. */
export function SoloGame() {
  const router = useRouter();
  const match = useSoloMatch('Officer');
  return <GameShell adapter={match} onLeave={() => router.push('/')} />;
}
