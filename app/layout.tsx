import type { Metadata, Viewport } from 'next';
import { Azeret_Mono, Spectral } from 'next/font/google';
import './globals.css';

const spectral = Spectral({
  variable: '--font-spectral',
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  style: ['normal', 'italic'],
  display: 'swap',
});

const azeret = Azeret_Mono({
  variable: '--font-azeret',
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Sea Battle — Naval Theater',
  description:
    'Golden-hour naval combat in 3D. Deploy your fleet and duel another commander over a shared room code.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b2634',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${spectral.variable} ${azeret.variable} h-full antialiased`}>
      <body className="min-h-full bg-abyss text-parchment">{children}</body>
    </html>
  );
}
