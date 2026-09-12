import type { Card, Pot } from '@poker/shared';
import { PlayingCard } from './PlayingCard';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * The middle of the table: the pot, and the board under it.
 *
 * Board cards are keyed by the card itself, so a card that was already there
 * keeps its identity across a re-render and only the new ones animate in. The
 * stagger comes from the index, which is why the flop lands as three cards
 * rather than one wide flash.
 */
export interface CommunityCardsProps {
  readonly board: readonly Card[];
  readonly potTotal: number;
  readonly pots: readonly Pot[];
  readonly chipsOnFelt: number;
}

export function CommunityCards({ board, potTotal, pots, chipsOnFelt }: CommunityCardsProps) {
  // One pot is just "the pot"; listing it as "Main" would only be noise. Side
  // pots exist exactly when the server says there is more than one layer.
  const hasSidePots = pots.length > 1;

  return (
    <div className="flex flex-col items-center gap-2.5">
      <div className="flex flex-col items-center gap-1">
        <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-400 uppercase">
          Pot
        </p>
        <p
          data-testid="pot-total"
          className="tabular text-2xl leading-none font-semibold text-neutral-50 sm:text-3xl"
        >
          {chips(potTotal)}
        </p>
        {chipsOnFelt > 0 ? (
          <p className="tabular text-[0.7rem] text-neutral-400">
            {chips(chipsOnFelt)} still in front
          </p>
        ) : null}
      </div>

      {hasSidePots ? (
        <ul className="flex flex-wrap justify-center gap-1.5">
          {pots.map((pot, index) => (
            <li
              key={`${String(index)}-${String(pot.amount)}`}
              className={cx(
                'rounded-full px-2.5 py-1 text-[0.7rem] ring-1',
                index === 0
                  ? 'bg-black/40 text-neutral-200 ring-white/15'
                  : 'bg-chip-1000/15 text-chip-1000 ring-chip-1000/35',
              )}
            >
              <span className="font-semibold">
                {index === 0 ? 'Main' : `Side ${String(index)}`}
              </span>{' '}
              <span className="tabular">{chips(pot.amount)}</span>
              <span className="sr-only">
                {' '}
                for {pot.eligibleSeats.length} eligible seat
                {pot.eligibleSeats.length === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex min-h-[4.5rem] items-center gap-1.5 sm:gap-2">
        {board.map((card, index) => (
          <PlayingCard
            key={`${String(card.rank)}${card.suit}`}
            card={card}
            size="md"
            // The flop lands as three staggered cards; the turn and the river
            // arrive alone, so they should not wait for a stagger that is not
            // there.
            dealIndex={index < 3 ? index : 0}
          />
        ))}
      </div>
    </div>
  );
}
