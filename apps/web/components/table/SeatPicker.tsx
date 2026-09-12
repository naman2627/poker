'use client';

import { useState } from 'react';
import type { PublicTableState, TableConfig } from '@poker/shared';
import { Button } from '../ui/Button';
import { chips } from '../../lib/format';

/**
 * Taking a chair.
 *
 * Shown only to somebody who is watching. The buy-in is bounded by the table's
 * own limits, and the server checks the number again when it arrives — this is
 * about not making a player guess what is allowed.
 */
export function SeatPicker({
  state,
  config,
  disabled,
  onSit,
}: {
  state: PublicTableState;
  config: TableConfig | null;
  disabled: boolean;
  onSit(seatIndex: number, buyIn: number): void;
}) {
  const min = config?.minBuyIn ?? state.bigBlind * 20;
  const max = config?.maxBuyIn ?? state.bigBlind * 200;
  const [buyIn, setBuyIn] = useState(max);

  const open = state.seats
    .map((seat, seatIndex) => (seat === null ? seatIndex : null))
    .filter((seatIndex): seatIndex is number => seatIndex !== null);

  if (open.length === 0) {
    return (
      <p className="rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-neutral-400">
        Every seat is taken. You are watching this one out.
      </p>
    );
  }

  return (
    <section
      aria-label="Take a seat"
      className="space-y-3 rounded-2xl border border-white/10 bg-black/25 p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-medium text-neutral-400">Buy in for</span>
          <input
            type="number"
            min={min}
            max={max}
            step={state.bigBlind}
            value={buyIn}
            disabled={disabled}
            onChange={(event) => {
              setBuyIn(event.currentTarget.valueAsNumber || min);
            }}
            className="tabular min-h-11 w-full rounded-lg bg-black/40 px-3 text-base text-neutral-50 ring-1 ring-white/15 focus:ring-accent focus:ring-2 focus:outline-none"
          />
        </label>
        <p className="tabular pb-3 text-xs text-neutral-500">
          {chips(min)} – {chips(max)}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {open.map((seatIndex) => (
          <Button
            key={seatIndex}
            variant="secondary"
            disabled={disabled || buyIn < min || buyIn > max}
            onClick={() => {
              onSit(seatIndex, buyIn);
            }}
            className="min-w-20 flex-1 text-xs"
          >
            Seat {seatIndex + 1}
          </Button>
        ))}
      </div>
    </section>
  );
}
