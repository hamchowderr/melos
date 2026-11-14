import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Instrument_Sans } from 'next/font/google';
import { cn } from '@/lib/utils';

// Owner decision 2026-11-14: Instrument Sans, compact for dense grids (replaces Geist).
const instrumentSans = Instrument_Sans({ subsets: ['latin'], variable: '--font-sans' });

export const metadata: Metadata = {
  title: 'Melos',
  description: 'Music catalog, rights and pitching workspace.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn('font-sans', instrumentSans.variable)}>
      <body>{children}</body>
    </html>
  );
}
