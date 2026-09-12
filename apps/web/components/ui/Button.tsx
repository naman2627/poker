import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';

/**
 * Every action in this app is a real `<button>`.
 *
 * Not a div with an onClick — a button, so it is in the tab order, fires on
 * Enter and Space, and announces itself. `min-h-11` is 44px, the smallest thing
 * a thumb reliably hits.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-accent text-felt-950 hover:brightness-110 font-semibold',
  secondary: 'bg-white/10 text-neutral-50 hover:bg-white/15 ring-1 ring-white/15',
  ghost: 'bg-transparent text-neutral-200 hover:bg-white/10 ring-1 ring-white/15',
  danger: 'bg-card-red/80 text-neutral-50 hover:bg-card-red',
  quiet: 'bg-transparent text-neutral-400 hover:text-neutral-100',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly children: ReactNode;
}

export function Button({ variant = 'secondary', className, children, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm',
        'transition-[background-color,filter,opacity] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}
