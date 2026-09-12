import type { Card, PublicSeat } from '@poker/shared';
import { Avatar } from '../ui/Avatar';
import { CardBack, PlayingCard } from './PlayingCard';
import { TimerRing } from './TimerRing';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * One seat.
 *
 * Everything on it comes from the seat the server sent. `holeCards` is only ever
 * non-null for the viewer's own seat, or for a hand a showdown made public — the
 * client has no way to fill it in and never tries; every other seat draws
 * `cardCount` backs.
 */
export interface SeatViewProps {
  readonly seat: PublicSeat;
  readonly isViewer: boolean;
  readonly isToAct: boolean;
  readonly isButton: boolean;
  readonly isWinner: boolean;
  readonly blind: 'small' | 'big' | null;
  /** The viewer's own cards, which arrive on their own event, not in the seat. */
  readonly viewerCards: readonly Card[] | null;
  readonly deadlineTs: number | null;
  readonly timeoutSec: number;
  /** Reached the showdown and did not turn over. */
  readonly mucked: boolean;
}

export function SeatView({
  seat,
  isViewer,
  isToAct,
  isButton,
  isWinner,
  blind,
  viewerCards,
  deadlineTs,
  timeoutSec,
  mucked,
}: SeatViewProps) {
  const folded = seat.status === 'folded';
  const cards = isViewer ? (seat.holeCards ?? viewerCards) : seat.holeCards;

  return (
    <div
      data-testid={`seat-${String(seat.seatIndex)}`}
      className={cx(
        'relative flex w-[7.5rem] flex-col items-center gap-1 sm:w-36',
        folded && 'opacity-55',
      )}
    >
      <HoleCards
        cards={cards}
        count={seat.cardCount}
        folded={folded || mucked}
        isViewer={isViewer}
      />

      <div
        className={cx(
          'relative flex w-full items-center gap-2 rounded-xl px-2 py-1.5',
          'bg-felt-950/85 ring-1 backdrop-blur-sm',
          isToAct ? 'ring-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'ring-white/10',
          isWinner && 'ring-chip-1000 shadow-[0_0_18px_-2px_var(--color-chip-1000)]',
        )}
      >
        <span className="relative shrink-0">
          <Avatar seed={seat.avatarSeed} name={seat.displayName} size={36} />
          {isToAct && deadlineTs !== null ? (
            <TimerRing
              deadlineTs={deadlineTs}
              totalSec={timeoutSec}
              size={44}
              className="absolute -inset-1"
            />
          ) : null}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-neutral-200">
            {seat.displayName}
            {isViewer ? <span className="text-accent"> (you)</span> : null}
          </span>
          <span
            data-testid={`seat-${String(seat.seatIndex)}-stack`}
            className="tabular block text-sm leading-tight font-semibold text-neutral-50"
          >
            {chips(seat.stack)}
          </span>
        </span>

        {isButton ? <Badge label="D" title="Dealer button" tone="button" /> : null}
        {blind === 'small' ? <Badge label="SB" title="Small blind" tone="blind" /> : null}
        {blind === 'big' ? <Badge label="BB" title="Big blind" tone="blind" /> : null}
      </div>

      <StatusPill
        status={seat.status}
        sittingOut={seat.sittingOut}
        leaving={seat.leaving}
        mucked={mucked}
      />
    </div>
  );
}

function HoleCards({
  cards,
  count,
  folded,
  isViewer,
}: {
  cards: readonly Card[] | null;
  count: number;
  folded: boolean;
  isViewer: boolean;
}) {
  if (count === 0 && (cards === null || cards.length === 0)) {
    return <span className="h-12 sm:h-[4.5rem]" />;
  }

  const size = isViewer ? 'md' : 'sm';

  return (
    <span className="flex -space-x-3 sm:-space-x-4">
      {cards !== null && cards.length > 0
        ? cards.map((card, index) => (
            <PlayingCard
              key={`${String(card.rank)}${card.suit}`}
              card={card}
              size={size}
              dealIndex={index}
              dimmed={folded}
              className="first:rotate-[-4deg] last:rotate-[4deg]"
            />
          ))
        : Array.from({ length: count }, (_unused, index) => (
            <CardBack
              key={index}
              size={size}
              dealIndex={index}
              className="first:rotate-[-4deg] last:rotate-[4deg]"
            />
          ))}
    </span>
  );
}

/**
 * The seat's state in one word. It is a `<span>` with text rather than a colour
 * on the avatar, because "folded" has to survive being read aloud.
 *
 * The order is deliberate: what is happening *now* beats what is going to happen
 * next. A player who is standing up is still in this hand until it reaches them,
 * and saying "Leaving" over the top of "All in" would be the less useful of the
 * two facts.
 */
function StatusPill({
  status,
  sittingOut,
  leaving,
  mucked,
}: {
  status: PublicSeat['status'];
  sittingOut: boolean;
  leaving: boolean;
  mucked: boolean;
}) {
  const pill = (text: string, tone: string) => (
    <span
      className={cx(
        'rounded-full px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase',
        tone,
      )}
    >
      {text}
    </span>
  );

  const quiet = 'bg-black/50 text-neutral-400 ring-1 ring-white/10';

  if (mucked) return pill('Mucked', quiet);

  switch (status) {
    case 'folded':
      return pill('Folded', quiet);
    case 'allin':
      return pill('All in', 'bg-chip-500/25 text-danger ring-1 ring-danger/40');
    case 'sitting_out':
      return pill('Sitting out', quiet);
    case 'active':
      if (leaving)
        return pill('Leaving', 'bg-amber-300/15 text-amber-200 ring-1 ring-amber-300/30');
      if (sittingOut) return pill('Out next hand', quiet);
      return null;
  }
}

function Badge({ label, title, tone }: { label: string; title: string; tone: 'button' | 'blind' }) {
  return (
    <span
      title={title}
      className={cx(
        'tabular grid h-5 w-5 shrink-0 place-items-center rounded-full text-[0.6rem] font-bold',
        tone === 'button'
          ? 'bg-neutral-100 text-neutral-900'
          : 'bg-black/60 text-neutral-300 ring-1 ring-white/15',
      )}
    >
      <span className="sr-only">{title}</span>
      <span aria-hidden>{label}</span>
    </span>
  );
}
