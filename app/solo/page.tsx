import type { Metadata } from 'next';
import { SoloGame } from '@/components/SoloGame';

export const metadata: Metadata = {
  title: 'Sea Battle — Solo Drill',
};

export default function SoloPage() {
  return <SoloGame />;
}
