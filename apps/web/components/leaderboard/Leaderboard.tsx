'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  LeaderboardMetricSchema,
  MIN_RANKED_HANDS,
  isRateMetric,
  type LeaderboardEntry,
  type LeaderboardMetric,
  type LeaderboardPeriod,
  type LeaderboardResponse,
} from '@poker/shared';
import { useSession } from '../../lib/auth/session';
import { StatsRequestError, fetchLeaderboard } from '../../lib/stats/api';
import { METRIC_LABELS, METRIC_SHORT, formatMetric, isSignedMetric } from '../../lib/stats/format';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Shell } from '../ui/Shell';

/**
 * The global boards.
 *
 * Three tabs, six metrics, fifty rows. Every number on the page came from the
 * server already computed; nothing here totals anything.
 *
 * The one piece of judgement in the interface is the threshold. A rate metric
 * ranks nobody with fewer than two hundred hands behind them, and the honest way
 * to show that is not to hide those players — it is to tell them how far off
 * they are. So an unranked row says "137 more hands to qualify" where its
 * position would be, and the boards those players *are* on (net chips, hands,
 * biggest pot) rank them normally.
 */
const PERIODS: readonly { value: LeaderboardPeriod; label: string }[] = [
  { value: 'alltime', label: 'All time' },
  { value: 'month', label: 'This month' },
  { value: 'week', label: 'This week' },
];

const METRICS = LeaderboardMetricSchema.options;

export function Leaderboard() {
  const router = useRouter();
  const { session, hydrate, hydrated } = useSession();

  const [metric, setMetric] = useState<LeaderboardMetric>('net');
  const [period, setPeriod] = useState<LeaderboardPeriod>('alltime');
  const [board, setBoard] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (hydrated && session === null) router.replace('/');
  }, [hydrated, router, session]);

  const token = session?.accessToken ?? null;

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    void fetchLeaderboard(token, metric, period)
      .then((response) => {
        if (cancelled) return;
        setBoard(response);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof StatsRequestError ? caught.body.message : 'that did not work');
      });

    return () => {
      cancelled = true;
    };
  }, [metric, period, token]);

  /**
   * Whether what is on screen is an answer to what is being asked.
   *
   * Derived rather than held: the response says which metric and period it is
   * for, so "still loading" is just "the board I have is not the board I asked
   * for". A `loading` flag set from inside the effect would say the same thing
   * one render later and cost a cascading render to do it.
   */
  const showing = board !== null && board.metric === metric && board.period === period;

  const viewer = showing ? (board?.viewer ?? null) : null;
  // Pinned only when the viewer is not already in the fifty — showing the same
  // person twice is worse than not pinning at all.
  const pinViewer =
    viewer !== null && !(board?.entries ?? []).some((entry) => entry.userId === viewer.userId);

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" className="px-0" onClick={() => router.push('/lobby')}>
            &larr; Lobby
          </Button>
          <h1 className="text-lg font-semibold text-neutral-50">Leaderboard</h1>
          <p className="text-xs text-neutral-500">Play chips. No value, ever.</p>
        </header>

        <nav aria-label="Period" className="flex gap-1 rounded-xl bg-black/25 p-1">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-current={period === option.value}
              onClick={() => {
                setPeriod(option.value);
              }}
              className={cx(
                'min-h-10 flex-1 rounded-lg px-3 text-sm transition-colors',
                period === option.value
                  ? 'bg-white/10 font-semibold text-neutral-50'
                  : 'text-neutral-400 hover:text-neutral-100',
              )}
            >
              {option.label}
            </button>
          ))}
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="metric" className="text-xs text-neutral-500">
            Ranked by
          </label>
          <select
            id="metric"
            value={metric}
            onChange={(event) => {
              setMetric(LeaderboardMetricSchema.parse(event.target.value));
            }}
            className="min-h-10 rounded-lg bg-white/10 px-3 text-sm text-neutral-50 ring-1 ring-white/15"
          >
            {METRICS.map((option) => (
              <option key={option} value={option} className="bg-neutral-900">
                {METRIC_LABELS[option]}
              </option>
            ))}
          </select>

          {isRateMetric(metric) ? (
            <p className="text-xs text-neutral-500">Ranked from {chips(MIN_RANKED_HANDS)} hands.</p>
          ) : null}
        </div>

        {error !== null ? (
          <p
            role="alert"
            className="border-danger/40 text-danger rounded-xl border bg-black/40 px-4 py-2.5 text-sm"
          >
            {error}
          </p>
        ) : null}

        {showing && board?.degraded === true ? (
          <p
            role="status"
            className="rounded-xl border border-amber-300/30 bg-amber-300/5 px-4 py-2.5 text-sm text-amber-200"
          >
            The fast index could not be reached, so this board was read straight from the record.
            The numbers are the same; it just took longer.
          </p>
        ) : null}

        {pinViewer && viewer !== null ? (
          <section aria-label="Your rank" className="rounded-2xl border border-white/15 bg-white/5">
            <Row entry={viewer} metric={metric} isViewer onOpen={openPlayer(router)} />
          </section>
        ) : null}

        {!showing && error === null ? (
          <p className="text-sm text-neutral-500">Reading the board…</p>
        ) : null}

        {showing && board !== null && board.entries.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-neutral-400">
            {isRateMetric(metric)
              ? `Nobody has played ${chips(MIN_RANKED_HANDS)} hands in this period yet.`
              : 'No hands have been counted for this period yet.'}
          </p>
        ) : null}

        {showing && board !== null && board.entries.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/25">
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2 text-xs text-neutral-500">
              <span className="w-6 shrink-0">#</span>
              <span className="flex-1">Player</span>
              <span className="w-24 shrink-0 text-right">{METRIC_SHORT[metric]}</span>
              <span className="hidden w-16 shrink-0 text-right sm:block">Hands</span>
            </div>

            <ol>
              {board.entries.map((entry) => (
                <li key={entry.userId} className="border-t border-white/[0.06] first:border-t-0">
                  <Row
                    entry={entry}
                    metric={metric}
                    isViewer={entry.userId === viewer?.userId}
                    onOpen={openPlayer(router)}
                  />
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </Shell>
  );
}

function openPlayer(router: ReturnType<typeof useRouter>) {
  return (userId: string): void => {
    router.push(`/player/${userId}`);
  };
}

function Row({
  entry,
  metric,
  isViewer,
  onOpen,
}: {
  entry: LeaderboardEntry;
  metric: LeaderboardMetric;
  isViewer: boolean;
  onOpen(userId: string): void;
}) {
  const signed = isSignedMetric(metric);

  return (
    <button
      type="button"
      onClick={() => {
        onOpen(entry.userId);
      }}
      className={cx(
        'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-white/5',
        isViewer ? 'bg-white/[0.04]' : null,
      )}
    >
      <span className="tabular w-6 shrink-0 text-sm text-neutral-500">
        {entry.rank === null ? '—' : entry.rank}
      </span>

      <Avatar seed={entry.avatarSeed} name={entry.displayName} size={32} />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-neutral-100">
          {entry.displayName === '' ? 'A player' : entry.displayName}
          {isViewer ? <span className="ml-1.5 text-xs text-neutral-500">(you)</span> : null}
        </span>
        {entry.qualified ? null : (
          // The threshold, said out loud. A player under it is not hidden and not
          // ranked — they are told how far off they are.
          <span className="block text-xs text-amber-200/80">
            {chips(entry.handsToQualify)} more hand{entry.handsToQualify === 1 ? '' : 's'} to
            qualify
          </span>
        )}
      </span>

      <span
        className={cx(
          'tabular w-24 shrink-0 text-right text-sm font-semibold',
          !entry.qualified
            ? 'text-neutral-500'
            : signed && entry.value > 0
              ? 'text-accent'
              : signed && entry.value < 0
                ? 'text-danger'
                : 'text-neutral-50',
        )}
      >
        {formatMetric(metric, entry.stats)}
      </span>

      <span className="tabular hidden w-16 shrink-0 text-right text-xs text-neutral-500 sm:block">
        {chips(entry.stats.handsPlayed)}
      </span>
    </button>
  );
}
