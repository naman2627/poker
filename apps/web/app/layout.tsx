import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Poker',
  description: 'Play-money Texas Hold’em.',
};

export const viewport: Viewport = {
  // The felt is laid out for portrait down to 360px; letting the browser zoom
  // out would only make the cards unreadable.
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0d1f17',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-felt-950 min-h-dvh text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
