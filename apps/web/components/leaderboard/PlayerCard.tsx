'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MIN_RANKED_HANDS,
  PLAYER_RECENT_HANDS,
  bbPer100,
  handCategoryLabel,
  winRatePercent,
  type PlayerHand,
  type PlayerProfileResponse,
} from '@poker/shared';
import { useSession } from '../../lib/auth/session';
import { StatsRequestError, fetchPlayer } from '../../lib/stats/api';
import { shortDate, signedChips } from '../../lib/stats/format';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Avatar } from '../ui/Avatar';
import { Button } from '../ui/Button';
import { Shell } from '../ui/Shell';

/**
 * One player's page: the stat card, and the last twenty hands.
 *
 * What is *not* here is as deliberate as what is. The hand list says what each
 * hand was worth to this player and whether it reached a showdown; it does not
 * say what they were holding. Cards are still `GET /hands/:id`, which decides
 * per reader — your own always, somebody else's only if they showed (CLAUDE.md
 * §1). A statistics page is no place to quietly route around that.
 */
export function PlayerCard({ userId }: { userId: string }) {
  const router = useRouter();
  const { session, hydrate, hydrated } = useSession();

  const [profile, setProfile] = useState<PlayerProfileResponse | null>(null);
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

    void fetchPlayer(token, userId)
      .then((found) => {
        if (!cancelled) setProfile(found);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof StatsRequestError ? caught.body.message : 'that did not work');
      });

    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  const stats = profile?.stats ?? null;
  const qualified = (stats?.handsPlayed ?? 0) >= MIN_RANKED_HANDS;

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" className="px-0" onClick={() => router.push('/leaderboard')}>
            &larr; Leaderboard
          </Button>
        </header>

        {error !== null ? (
          <p
            role="alert"
            className="border-danger/40 text-danger rounded-xl border bg-black/40 px-4 py-2.5 text-sm"
          >
            {error}
          </p>
        ) : null}

        {profile === null && error === null ? (
          <p className="text-sm text-neutral-500">Reading the record…</p>
        ) : null}

        {profile !== null && stats !== null ? (
          <>
            <section className="flex items-center gap-4 rounded-2xl border border-white/10 bg-black/25 px-4 py-4">
              <Avatar seed={profile.avatarSeed} name={profile.displayName} size={56} />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold text-neutral-50">
                  {profile.displayName === '' ? 'A player' : profile.displayName}
                </h1>
                <p className="tabular text-xs text-neutral-500">
                  {chips(stats.handsPlayed)} hand{stats.handsPlayed === 1 ? '' : 's'} counted
                  {profile.ranks.net === null
                    ? null
                    : ` · #${String(profile.ranks.net)} by net chips`}
                </p>
              </div>
            </section>

            <section aria-label="Statistics" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat
                label="Net chips"
                value={signedChips(stats.netChips)}
                tone={stats.netChips > 0 ? 'good' : stats.netChips < 0 ? 'bad' : 'flat'}
                rank={profile.ranks.net}
              />
              <Stat
                label="Hands played"
                value={chips(stats.handsPlayed)}
                rank={profile.ranks.hands}
              />
              <Stat
                label="Win rate"
                value={`${winRatePercent(stats.handsWon, stats.handsPlayed).toFixed(1)}%`}
                rank={profile.ranks.winRate}
                unqualified={!qualified}
                toQualify={MIN_RANKED_HANDS - stats.handsPlayed}
              />
              <Stat
                label="BB/100"
                value={bbPer100(stats.netChips, stats.bigBlind, stats.handsPlayed).toFixed(2)}
                tone={stats.netChips > 0 ? 'good' : stats.netChips < 0 ? 'bad' : 'flat'}
                rank={profile.ranks.bb100}
                unqualified={!qualified}
                toQualify={MIN_RANKED_HANDS - stats.handsPlayed}
              />
              <Stat
                label="Biggest pot"
                value={chips(stats.biggestPot)}
                rank={profile.ranks.biggestPot}
              />
              <Stat
                label="Best hand"
                value={handCategoryLabel(stats.bestHandCategory)}
                note={shortDate(stats.bestHandAt)}
                rank={profile.ranks.bestHand}
              />
              <Stat
                label="Showdowns"
                value={`${chips(stats.showdownsWon)} / ${chips(stats.showdownsSeen)}`}
                note="won / seen"
              />
              <Stat label="Total wagered" value={chips(stats.totalWagered)} />
              <Stat
                label="Win streak"
                value={chips(stats.currentWinStreak)}
                note={`longest ${chips(stats.longestWinStreak)}`}
              />
            </section>

            <section aria-label="Recent hands" className="flex flex-col gap-2">
              <h2 className="text-xs font-semibold tracking-wide text-neutral-400 uppercase">
                Last {PLAYER_RECENT_HANDS} hands
              </h2>

              {profile.recentHands.length === 0 ? (
                <p className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-neutral-400">
                  No finished hands yet.
                </p>
              ) : (
                <ol className="overflow-hidden rounded-2xl border border-white/10 bg-black/25">
                  {profile.recentHands.map((hand) => (
                    <li key={hand.handId} className="border-t border-white/[0.06] first:border-t-0">
                      <HandRow hand={hand} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Shell>
  );
}

function Stat({
  label,
  value,
  note,
  tone = 'flat',
  rank,
  unqualified = false,
  toQualify = 0,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'good' | 'bad' | 'flat';
  rank?: number | null;
  unqualified?: boolean;
  toQualify?: number;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/25 px-3 py-3">
      <p className="text-xs text-neutral-500">{label}</p>
      <p
        className={cx(
          'tabular mt-0.5 text-lg font-semibold',
          unqualified
            ? 'text-neutral-500'
            : tone === 'good'
              ? 'text-accent'
              : tone === 'bad'
                ? 'text-danger'
                : 'text-neutral-50',
        )}
      >
        {value}
      </p>
      {unqualified ? (
        <p className="text-xs text-amber-200/80">
          {chips(Math.max(0, toQualify))} more hand{toQualify === 1 ? '' : 's'} to qualify
        </p>
      ) : rank === undefined ? null : rank === null ? null : (
        <p className="tabular text-xs text-neutral-500">#{rank}</p>
      )}
      {note !== undefined && !unqualified ? (
        <p className="text-xs text-neutral-600">{note}</p>
      ) : null}
    </div>
  );
}

function HandRow({ hand }: { hand: PlayerHand }) {
  const net = hand.net ?? 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="tabular w-16 shrink-0 truncate text-xs tracking-wider text-neutral-500">
        {hand.tableCode}
      </span>
      <span className="tabular w-10 shrink-0 text-xs text-neutral-600">#{hand.handNumber}</span>

      <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">
        {hand.wentToShowdown ? 'showdown' : 'no showdown'}
        {hand.won ? ' · won' : ''}
      </span>

      <span className="tabular shrink-0 text-xs text-neutral-600">pot {chips(hand.totalPot)}</span>

      <span
        className={cx(
          'tabular w-20 shrink-0 text-right text-sm font-semibold',
          net > 0 ? 'text-accent' : net < 0 ? 'text-danger' : 'text-neutral-500',
        )}
      >
        {signedChips(net)}
      </span>
    </div>
  );
}
