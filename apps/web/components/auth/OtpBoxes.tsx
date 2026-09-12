'use client';

import { useEffect, useRef } from 'react';
import { OTP_LENGTH, applyOtpBackspace, applyOtpInput } from '../../lib/otp';
import { cx } from '../../lib/cx';

/**
 * Six boxes for a six-digit code.
 *
 * The behaviours that matter are the ones people do without thinking:
 *
 *   paste anywhere and the whole row fills — from "424242", from "424 242", from
 *   "Your code is 424242", because `applyOtpInput` throws away everything that
 *   is not a digit
 *
 *   backspace on an empty box steps back and clears the one before it
 *
 *   the sixth digit submits, so nobody hunts for a button
 *
 * Each box is a real `<input>` with its own label, so a screen reader says
 * "digit 3 of 6" rather than six anonymous fields.
 */
export interface OtpBoxesProps {
  readonly digits: readonly string[];
  readonly disabled: boolean;
  readonly invalid: boolean;
  onChange(digits: string[]): void;
  onComplete(code: string): void;
}

export function OtpBoxes({ digits, disabled, invalid, onChange, onComplete }: OtpBoxesProps) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // The first empty box is where typing should land when the screen opens.
  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);

  const focus = (index: number): void => {
    boxes.current[Math.min(OTP_LENGTH - 1, Math.max(0, index))]?.focus();
  };

  const commit = (next: string[], caret: number): void => {
    onChange(next);
    focus(caret);
    if (next.every((digit) => /^\d$/.test(digit))) onComplete(next.join(''));
  };

  return (
    <div className="flex justify-between gap-1.5 sm:gap-2" role="group" aria-label="Six-digit code">
      {Array.from({ length: OTP_LENGTH }, (_unused, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element;
          }}
          type="text"
          inputMode="numeric"
          // One shared autocomplete token: the browser offers the SMS code on
          // whichever box has focus, and the paste handling spreads it.
          autoComplete="one-time-code"
          aria-label={`Digit ${String(index + 1)} of ${String(OTP_LENGTH)}`}
          aria-invalid={invalid || undefined}
          maxLength={OTP_LENGTH}
          disabled={disabled}
          value={digits[index] ?? ''}
          onChange={(event) => {
            const { digits: next, caret } = applyOtpInput(digits, index, event.currentTarget.value);
            commit(next, caret);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace') {
              event.preventDefault();
              const { digits: next, caret } = applyOtpBackspace(digits, index);
              onChange(next);
              focus(caret);
              return;
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault();
              focus(index - 1);
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              focus(index + 1);
            }
          }}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className={cx(
            'tabular h-14 min-w-0 flex-1 rounded-xl bg-black/35 text-center text-2xl font-semibold',
            'text-neutral-50 ring-1 ring-white/15',
            'focus:ring-accent focus:ring-2 focus:outline-none',
            'disabled:opacity-50',
            invalid && 'ring-danger ring-2',
          )}
        />
      ))}
    </div>
  );
}
