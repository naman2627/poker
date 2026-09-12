'use client';

import { useId } from 'react';
import type { LegalActions } from '@poker/shared';
import { Button } from '../ui/Button';
import { POT_PRESETS, potFractionRaise, raiseBounds, snapRaise } from '../../lib/raise';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * The raise slider and its shortcuts.
 *
 * The range is the server's: `minRaiseTo` and `maxRaiseTo` come straight off
 * `action:prompt` and the slider cannot leave them. The pot buttons are a
 * convenience — they put the handle somewhere sensible and are clamped back
 * inside the legal range before they can propose anything. The server checks the
 * number again when it arrives (CLAUDE.md §4); nothing here is an authority.
 */
export interface RaiseControlProps {
  readonly legal: LegalActions;
  readonly bigBlind: number;
  readonly potTotal: number;
  readonly currentBet: number;
  readonly value: number;
  readonly disabled: boolean;
  onChange(value: number): void;
  onConfirm(): void;
}

export function RaiseControl({
  legal,
  bigBlind,
  potTotal,
  currentBet,
  value,
  disabled,
  onChange,
  onConfirm,
}: RaiseControlProps) {
  const sliderId = useId();
  const bounds = raiseBounds(legal, bigBlind);
  const isBet = legal.canBet && !legal.canRaise;
  const atMax = value >= bounds.max;

  const preset = (fraction: number): number =>
    potFractionRaise(fraction, { potTotal, callAmount: legal.callAmount, currentBet }, bounds);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {POT_PRESETS.map(({ label, fraction }) => {
          const target = preset(fraction);
          return (
            <Button
              key={label}
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                onChange(target);
              }}
              aria-pressed={value === target}
              className={cx('flex-1 px-2 text-xs', value === target && 'ring-accent ring-2')}
            >
              {label}
            </Button>
          );
        })}
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            onChange(bounds.max);
          }}
          aria-pressed={atMax}
          className={cx('flex-1 px-2 text-xs', atMax && 'ring-accent ring-2')}
        >
          All in
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <label htmlFor={sliderId} className="sr-only">
          {isBet ? 'Bet amount' : 'Raise to'}
        </label>
        <input
          id={sliderId}
          type="range"
          min={bounds.min}
          max={bounds.max}
          step={1}
          value={value}
          disabled={disabled || bounds.max <= bounds.min}
          aria-valuetext={`${chips(value)} chips`}
          onChange={(event) => {
            onChange(snapRaise(event.currentTarget.valueAsNumber, bounds));
          }}
          className="accent-accent h-11 min-w-0 flex-1 cursor-pointer disabled:cursor-not-allowed"
        />

        <output
          htmlFor={sliderId}
          className="tabular min-w-[5.5rem] rounded-lg bg-black/40 px-3 py-2 text-right text-sm font-semibold text-neutral-50 ring-1 ring-white/15"
        >
          {chips(value)}
        </output>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="tabular text-xs text-neutral-500">
          {chips(bounds.min)} – {chips(bounds.max)}
        </p>
        <Button
          variant="primary"
          data-testid="confirm-raise"
          disabled={disabled}
          onClick={onConfirm}
          className="min-w-32"
        >
          {atMax ? 'All in' : isBet ? `Bet ${chips(value)}` : `Raise to ${chips(value)}`}
        </Button>
      </div>
    </div>
  );
}
