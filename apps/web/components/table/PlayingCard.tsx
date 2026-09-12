import type { Card } from '@poker/shared';
import { cardLabel, isRedSuit, rankLabel, suitGlyph } from '../../lib/cards';
import { cx } from '../../lib/cx';

/**
 * A card face.
 *
 * Rank and suit go in opposite corners, the second pair rotated a half turn, the
 * way a real deck is printed — so a card is readable from either end and stays
 * readable when it is overlapped by the one in front of it.
 *
 * Red is `--color-card-red`, a deep slightly-orange red. Pure #FF0000 on a green
 * felt vibrates at the edges and turns to mush at the size a corner index is
 * actually drawn.
 */
export type CardSize = 'sm' | 'md' | 'lg';

const SIZES: Readonly<Record<CardSize, { box: string; index: string; pip: string }>> = {
  sm: { box: 'h-12 w-[2.1rem] rounded', index: 'text-[0.6rem]', pip: 'text-base' },
  md: { box: 'h-[4.5rem] w-[3.15rem] rounded-md', index: 'text-[0.72rem]', pip: 'text-2xl' },
  lg: { box: 'h-24 w-[4.2rem] rounded-lg', index: 'text-sm', pip: 'text-4xl' },
};

export interface PlayingCardProps {
  readonly card: Card;
  readonly size?: CardSize;
  /** Index into a dealt row, used to stagger the deal animation. */
  readonly dealIndex?: number;
  readonly dimmed?: boolean;
  readonly className?: string;
}

export function PlayingCard({
  card,
  size = 'md',
  dealIndex,
  dimmed = false,
  className,
}: PlayingCardProps) {
  const metrics = SIZES[size];
  const red = isRedSuit(card.suit);
  const rank = rankLabel(card.rank);
  const suit = suitGlyph(card.suit);

  return (
    <div
      role="img"
      aria-label={cardLabel(card)}
      style={
        dealIndex === undefined ? undefined : { animationDelay: `${String(dealIndex * 110)}ms` }
      }
      className={cx(
        'bg-card-face relative shrink-0 select-none',
        'shadow-[0_2px_6px_rgba(0,0,0,0.45)] ring-1 ring-black/25',
        metrics.box,
        dealIndex === undefined ? null : 'animate-deal-in',
        dimmed && 'opacity-55 saturate-50',
        className,
      )}
    >
      <Corner rank={rank} suit={suit} red={red} size={metrics.index} />
      <span
        aria-hidden
        className={cx(
          'absolute inset-0 flex items-center justify-center leading-none',
          metrics.pip,
          red ? 'text-card-red' : 'text-card-ink',
          'opacity-25',
        )}
      >
        {suit}
      </span>
      <Corner rank={rank} suit={suit} red={red} size={metrics.index} flipped />
    </div>
  );
}

function Corner({
  rank,
  suit,
  red,
  size,
  flipped = false,
}: {
  rank: string;
  suit: string;
  red: boolean;
  size: string;
  flipped?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        'absolute flex flex-col items-center leading-[0.95] font-semibold',
        size,
        red ? 'text-card-red' : 'text-card-ink',
        flipped ? 'right-0.5 bottom-0.5 rotate-180' : 'top-0.5 left-0.5',
      )}
    >
      <span className="tabular">{rank}</span>
      <span>{suit}</span>
    </span>
  );
}

/** A card that is in play but not this viewer's to see. */
export function CardBack({
  size = 'md',
  dealIndex,
  className,
}: {
  size?: CardSize;
  dealIndex?: number;
  className?: string;
}) {
  const metrics = SIZES[size];

  return (
    <div
      aria-hidden
      style={
        dealIndex === undefined ? undefined : { animationDelay: `${String(dealIndex * 110)}ms` }
      }
      className={cx(
        'bg-card-back relative shrink-0 ring-1 ring-black/30',
        'shadow-[0_2px_6px_rgba(0,0,0,0.4)]',
        metrics.box,
        dealIndex === undefined ? null : 'animate-deal-in',
        className,
      )}
    >
      <span className="absolute inset-[3px] rounded-[3px] bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.14)_0_3px,transparent_3px_6px)]" />
    </div>
  );
}
