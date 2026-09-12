import type { HandResultPayload, PublicTableState } from '@poker/shared';
import { PlayingCard } from './PlayingCard';
import { chips } from '../../lib/format';

/**
 * How the last hand finished.
 *
 * Pots are listed the way they were played for — the main pot and each side pot
 * separately, because "Ines won 505 and Naman won 430" is the whole story of a
 * hand where somebody was all in, and one combined number tells none of it.
 *
 * Every card and every name here came from `hand:result`. The client has no
 * opinion about who won.
 */
export function HandResultPanel({
  result,
  state,
}: {
  result: HandResultPayload | null;
  state: PublicTableState | null;
}) {
  if (result === null) return null;

  const nameOf = (seatIndex: number): string =>
    state?.seats[seatIndex]?.displayName ?? `Seat ${String(seatIndex + 1)}`;

  return (
    <section
      aria-label="Hand result"
      className="space-y-3 rounded-2xl border border-white/10 bg-black/25 p-4"
    >
      <h2 className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-400 uppercase">
        Result
      </h2>

      <ul className="space-y-1.5">
        {result.pots.map((pot, index) => {
          const winners = result.awards.filter((award) => award.potIndex === index);

          return (
            <li key={index} className="flex items-baseline gap-2 text-sm">
              <span className="w-14 shrink-0 text-xs text-neutral-500">
                {index === 0 ? 'Main' : `Side ${String(index)}`}
              </span>
              <span className="tabular w-16 shrink-0 font-semibold text-neutral-100">
                {chips(pot.amount)}
              </span>
              <span className="min-w-0 flex-1 truncate text-neutral-300">
                {winners.length === 0
                  ? '—'
                  : winners
                      .map((award) => `${nameOf(award.seatIndex)} ${chips(award.amount)}`)
                      .join(', ')}
              </span>
            </li>
          );
        })}
      </ul>

      {result.revealed.length > 0 ? (
        <ul className="space-y-2 border-t border-white/10 pt-3">
          {result.revealed.map((reveal) => (
            <li key={reveal.seatIndex} className="flex items-center gap-2.5">
              <span className="flex -space-x-2">
                {reveal.cards.map((card) => (
                  <PlayingCard key={`${String(card.rank)}${card.suit}`} card={card} size="sm" />
                ))}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm text-neutral-200">
                  {nameOf(reveal.seatIndex)}
                </span>
                <span className="block truncate text-xs text-neutral-500">{reveal.handName}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
