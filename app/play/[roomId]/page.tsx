import type { Metadata } from 'next';
import { OnlineGame } from '@/components/OnlineGame';
import { normalizeRoomId } from '@/lib/net/protocol';

export const metadata: Metadata = {
  title: 'Sea Battle — Engagement',
};

export default async function PlayPage({ params }: PageProps<'/play/[roomId]'>) {
  const { roomId } = await params;
  return <OnlineGame roomId={normalizeRoomId(roomId)} />;
}
