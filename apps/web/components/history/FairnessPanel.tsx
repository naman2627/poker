'use client';

import type { HandVerification } from '@poker/shared';
import { PlayingCard } from '../table/PlayingCard';
import { parseCardCodes } from '../../lib/history/cards';
import { cx } from '../../lib/cx';

/**
 * The proof, laid out so it can be checked rather than believed.
 *
 * Two claims, shown separately because they mean different things and a green
 * tick over both of them would hide which one failed:
 *
 *   the seed hashes to the commitment the table published *before* the deal
 *   the deck that seed produces is the deal that actually happened
 *
 * Both are recomputed by the server on request — and can be recomputed by
 * anybody, from the seed and commitment printed here, using nothing but SHA-256
 * and a Fisher-Yates shuffle.
 */
export function FairnessPanel({ result }: { result: HandVerification }) {
  if (result.reason !== null) {
    return (
      <p className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-neutral-400">
        {result.reason}
      </p>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-black/25 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Verdict ok={result.verified} />
        <p className="text-xs text-neutral-500">
          Recomputed from the published seed. Nothing here is taken on trust.
        </p>
      </div>

      <ul className="space-y-1.5 text-sm">
        <Check
          ok={result.commitmentMatches}
          label="The seed opens the commitment"
          detail="sha256 of the seed below equals the commitment published before the deal."
        />
        <Check
          ok={result.dealMatches}
          label="The committed deck is the one that was dealt"
          detail="Shuffling from that seed and dealing again gives the cards on record."
        />
      </ul>

      <dl className="space-y-2">
        <Field label="Commitment (published before the deal)" value={result.deckCommit} />
        <Field label="Seed (published when the hand ended)" value={result.deckSeed ?? '—'} />
      </dl>

      <div className="space-y-2 border-t border-white/10 pt-3">
        <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-400 uppercase">
          Board
        </p>
        <Row
          matches={result.board.matches}
          computed={result.board.computed}
          recorded={result.board.recorded}
        />
      </div>

      <div className="space-y-2 border-t border-white/10 pt-3">
        <p className="text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-400 uppercase">
          Seats
        </p>
        <ul className="space-y-2">
          {result.seats.map((seat) => (
            <li key={seat.seatIndex} className="flex flex-wrap items-center gap-3">
              <span className="w-28 shrink-0 truncate text-sm text-neutral-300">
                {seat.displayName}
              </span>
              {seat.recorded === null ? (
                // Checked, and still not shown. Mucking is a refusal to publish,
                // not a delay on it.
                <span className="text-xs text-neutral-500">
                  mucked — {seat.matches ? 'checked and correct' : 'does not match'}
                </span>
              ) : (
                <Row matches={seat.matches} computed={seat.computed} recorded={seat.recorded} />
              )}
            </li>
          ))}
        </ul>
      </div>

      <details className="border-t border-white/10 pt-3">
        <summary className="cursor-pointer text-xs text-neutral-400">
          The whole deck this seed produces, top first
        </summary>
        <p className="tabular mt-2 text-xs leading-relaxed break-words text-neutral-500">
          {result.deck.map((card) => `${String(card.rank)}${card.suit}`).join(' ')}
        </p>
      </details>
    </div>
  );
}

function Verdict({ ok }: { ok: boolean }) {
  return (
    <span
      className={cx(
        'rounded-full px-3 py-1 text-xs font-semibold tracking-wide uppercase',
        ok ? 'bg-accent/15 text-accent' : 'bg-danger/15 text-danger',
      )}
    >
      {ok ? 'Verified' : 'Does not check out'}
    </span>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex gap-2">
      <span aria-hidden className={ok ? 'text-accent' : 'text-danger'}>
        {ok ? '✓' : '✗'}
      </span>
      <span>
        <span className="sr-only">{ok ? 'Passed: ' : 'Failed: '}</span>
        <span className="text-neutral-200">{label}</span>
        <span className="block text-xs text-neutral-500">{detail}</span>
      </span>
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="tabular text-xs break-all text-neutral-300">{value}</dd>
    </div>
  );
}

function Row({
  matches,
  computed,
  recorded,
}: {
  matches: boolean;
  computed: readonly string[];
  recorded: readonly string[];
}) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="flex -space-x-2">
        {parseCardCodes(computed).map((card) => (
          <PlayingCard key={`${String(card.rank)}${card.suit}`} card={card} size="sm" />
        ))}
      </span>
      <span className={cx('text-xs', matches ? 'text-accent' : 'text-danger')}>
        {matches ? 'matches the record' : `record says ${recorded.join(' ')}`}
      </span>
    </span>
  );
}
