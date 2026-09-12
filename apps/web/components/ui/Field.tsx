import type { InputHTMLAttributes, ReactNode } from 'react';
import { useId } from 'react';
import { cx } from '../../lib/cx';

/**
 * A labelled input.
 *
 * The label is a real `<label>` tied to the input by id, the hint and the error
 * are wired through `aria-describedby`, and an invalid field says so with
 * `aria-invalid` rather than only turning red — colour is not a message.
 */
export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | null;
}

export function Field({ label, hint, error, className, ...rest }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-neutral-300">
        {label}
      </label>

      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        {...rest}
        className={cx(
          'min-h-11 w-full rounded-lg bg-black/30 px-3.5 text-base text-neutral-50',
          'ring-1 ring-white/15 placeholder:text-neutral-500',
          'focus:ring-accent focus:ring-2 focus:outline-none',
          error && 'ring-danger ring-2',
          className,
        )}
      />

      {hint ? (
        <p id={hintId} className="text-xs text-neutral-500">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="text-danger text-xs font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
