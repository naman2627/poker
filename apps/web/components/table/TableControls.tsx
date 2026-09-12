'use client';

import { useState } from 'react';
import type { PublicSeat, PublicTableState, TableConfig } from '@poker/shared';
import { Button } from '../ui/Button';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * Everything a seated player can do that is not a betting action.
 *
 * The rules these buttons obey are the server's, and each one says what it will
 * actually do rather than what it is called:
 *
 *   sitting out takes effect from the *next* hand, never this one
 *   standing up mid-hand folds when the action reaches you, not now
 *   a rebuy is only possible between hands, so it is offered only then
 *   pausing lets the hand in progress finish
 */
export interface TableControlsProps {
  readonly state: PublicTableState;
  readonly seat: PublicSeat;
  readonly config: TableConfig | null;
  readonly isHost: boolean;
  readonly live: boolean;
  onSitOut(sittingOut: boolean): void;
  onLeave(): void;
  onRebuy(amount: number): void;
  onPause(paused: boolean): void;
  onShow(): void;
  readonly canShow: boolean;
}

export function TableControls({
  state,
  seat,
  config,
  isHost,
  live,
  onSitOut,
  onLeave,
  onRebuy,
  onPause,
  onShow,
  canShow,
}: TableControlsProps) {
  const betweenHands = state.phase === 'waiting' || state.phase === 'hand_end';
  const maxBuyIn = config?.maxBuyIn ?? 0;
  const topUp = Math.max(0, maxBuyIn - seat.stack);

  return (
    <section
      aria-label="Table controls"
      className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-3"
    >
      <Status state={state} seat={seat} />

      <span className="ml-auto flex flex-wrap gap-2">
        {canShow ? (
          <Button variant="primary" disabled={!live} onClick={onShow} className="text-xs">
            Show my hand
          </Button>
        ) : null}

        {seat.sittingOut ? (
          <Button
            variant="primary"
            disabled={!live || seat.stack === 0}
            onClick={() => {
              onSitOut(false);
            }}
            className="text-xs"
          >
            {state.handNumber === 0 ? "I'm in" : 'Deal me in'}
          </Button>
        ) : (
          <Button
            variant="ghost"
            disabled={!live}
            onClick={() => {
              onSitOut(true);
            }}
            className="text-xs"
          >
            Sit out next hand
          </Button>
        )}

        {betweenHands && topUp > 0 ? (
          <RebuyButton live={live} topUp={topUp} onRebuy={onRebuy} />
        ) : null}

        {isHost ? (
          <Button
            variant="ghost"
            disabled={!live}
            onClick={() => {
              onPause(!state.paused);
            }}
            className="text-xs"
          >
            {state.paused ? 'Resume table' : 'Pause table'}
          </Button>
        ) : null}

        <Button
          variant="quiet"
          disabled={!live || seat.leaving}
          onClick={onLeave}
          className="text-xs"
        >
          {seat.leaving ? 'Leaving…' : 'Stand up'}
        </Button>
      </span>
    </section>
  );
}

/** One line saying what is about to happen to this seat, and why. */
function Status({ state, seat }: { state: PublicTableState; seat: PublicSeat }) {
  const line = ((): { text: string; tone?: string } => {
    if (seat.leaving) return { text: 'Standing up — your hand folds when the action reaches you.' };
    if (state.paused) return { text: 'The host paused the table. This hand finishes first.' };
    if (seat.stack === 0) return { text: 'Out of chips. Rebuy to be dealt in again.' };
    if (seat.sittingOut) return { text: 'Sitting out. You are not in the next hand.' };
    if (state.phase === 'waiting') return { text: 'Waiting for another player.' };
    return { text: 'Dealt in.', tone: 'text-neutral-500' };
  })();

  return (
    <p className={cx('min-w-0 flex-1 text-xs', line.tone ?? 'text-neutral-400')}>{line.text}</p>
  );
}

function RebuyButton({
  live,
  topUp,
  onRebuy,
}: {
  live: boolean;
  topUp: number;
  onRebuy(amount: number): void;
}) {
  const [asking, setAsking] = useState(false);
  const [amount, setAmount] = useState(topUp);

  if (!asking) {
    return (
      <Button
        variant="secondary"
        disabled={!live}
        onClick={() => {
          setAmount(topUp);
          setAsking(true);
        }}
        className="text-xs"
      >
        Rebuy
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <label className="sr-only" htmlFor="rebuy-amount">
        Rebuy amount
      </label>
      <input
        id="rebuy-amount"
        type="number"
        min={1}
        max={topUp}
        value={amount}
        onChange={(event) => {
          setAmount(event.currentTarget.valueAsNumber || 0);
        }}
        className="tabular min-h-11 w-24 rounded-lg bg-black/40 px-2 text-sm text-neutral-50 ring-1 ring-white/15 focus:ring-accent focus:ring-2 focus:outline-none"
      />
      <Button
        variant="primary"
        disabled={!live || amount < 1 || amount > topUp}
        onClick={() => {
          onRebuy(amount);
          setAsking(false);
        }}
        className="text-xs"
      >
        Add {chips(amount)}
      </Button>
      <Button
        variant="quiet"
        onClick={() => {
          setAsking(false);
        }}
        className="text-xs"
      >
        Cancel
      </Button>
    </span>
  );
}
