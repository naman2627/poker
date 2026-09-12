import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * The chips a seat has pushed forward on this street.
 *
 * Breaking the amount into denominations is presentation, not accounting: the
 * number beside the stack is the server's, and the discs are just a way of
 * seeing at a glance that one player has bet far more than another. Tallest
 * denomination first, at most five discs, because a tower of forty is a smear.
 */
const DENOMINATIONS = [
  { value: 1000, className: 'bg-chip-1000' },
  { value: 500, className: 'bg-chip-500' },
  { value: 100, className: 'bg-chip-100' },
  { value: 25, className: 'bg-chip-25' },
  { value: 5, className: 'bg-chip-5' },
] as const;

const MAX_DISCS = 5;

export function chipDiscs(amount: number): readonly string[] {
  const discs: string[] = [];
  let left = amount;

  for (const denomination of DENOMINATIONS) {
    while (left >= denomination.value && discs.length < MAX_DISCS) {
      discs.push(denomination.className);
      left -= denomination.value;
    }
  }

  if (discs.length === 0 && amount > 0) discs.push('bg-chip-5');
  return discs;
}

export function ChipStack({ amount, className }: { amount: number; className?: string }) {
  if (amount <= 0) return null;
  const discs = chipDiscs(amount);

  return (
    <div className={cx('animate-chip-in flex items-center gap-1.5', className)}>
      <span className="relative block h-4 w-4" aria-hidden>
        {discs.map((disc, index) => (
          <span
            key={`${disc}-${String(index)}`}
            style={{ bottom: `${String(index * 3)}px` }}
            className={cx(
              'absolute left-0 h-2.5 w-4 rounded-full ring-1 ring-black/40',
              'shadow-[0_1px_2px_rgba(0,0,0,0.5)]',
              disc,
            )}
          />
        ))}
      </span>

      <span className="tabular rounded bg-black/55 px-1.5 py-0.5 text-[0.7rem] font-semibold text-neutral-100 ring-1 ring-white/10">
        {chips(amount)}
      </span>
    </div>
  );
}
