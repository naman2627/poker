import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';

/** The page ground: felt at the edges, a soft light above the table. */
export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cx(
        'min-h-dvh bg-[radial-gradient(ellipse_at_50%_-10%,var(--color-felt-800),var(--color-felt-950)_70%)]',
        className,
      )}
    >
      {children}
    </main>
  );
}
