'use client';

import {
  bbPer100,
  handCategoryLabel,
  winRatePercent,
  type LeaderboardMetric,
  type PlayerStatCard,
} from '@poker/shared';
import { chips } from '../format';

/**
 * How each metric reads on screen.
 *
 * The numbers themselves come from @poker/shared, which is where the server got
 * them too — so the column a player is ranked on and the column they are shown
 * are the same arithmetic, not two implementations that agree most of the time.
 * This file only decides how many decimal places and which sign.
 */

export const METRIC_LABELS: Readonly<Record<LeaderboardMetric, string>> = {
  net: 'Net chips',
  hands: 'Hands',
  winRate: 'Win rate',
  bb100: 'BB/100',
  biggestPot: 'Biggest pot',
  bestHand: 'Best hand',
};

/** The short column heading, for a table that has to fit on a phone. */
export const METRIC_SHORT: Readonly<Record<LeaderboardMetric, string>> = {
  net: 'Net',
  hands: 'Hands',
  winRate: 'Win %',
  bb100: 'BB/100',
  biggestPot: 'Best pot',
  bestHand: 'Best hand',
};

/** Chips, with an explicit `+` on a win — a leading minus alone is easy to miss. */
export function signedChips(amount: number): string {
  return amount > 0 ? `+${chips(amount)}` : chips(amount);
}

export function formatMetric(metric: LeaderboardMetric, stats: PlayerStatCard): string {
  switch (metric) {
    case 'net':
      return signedChips(stats.netChips);
    case 'hands':
      return chips(stats.handsPlayed);
    case 'winRate':
      return `${winRatePercent(stats.handsWon, stats.handsPlayed).toFixed(1)}%`;
    case 'bb100': {
      const value = bbPer100(stats.netChips, stats.bigBlind, stats.handsPlayed);
      return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
    }
    case 'biggestPot':
      return chips(stats.biggestPot);
    case 'bestHand':
      return handCategoryLabel(stats.bestHandCategory);
  }
}

/** Whether a bigger number is a better number. Used only to colour a value. */
export function isSignedMetric(metric: LeaderboardMetric): boolean {
  return metric === 'net' || metric === 'bb100';
}

/** `12 Aug 2026`, or an em dash when there is no date to show. */
export function shortDate(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
