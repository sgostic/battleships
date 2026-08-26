import type { Metadata } from 'next';
import { SoloGame } from '@/components/SoloGame';

export const metadata: Metadata = {
  title: 'Sea Battle — Solo Drill',
};

export default async function SoloPage({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const params = await searchParams;
  return <SoloGame duo={params.mode === 'duo'} />;
}
