/**
 * One finished hand, turned into counters.
 *
 * Pure functions and exact assertions. Everything that decides what a
 * leaderboard eventually says is decided in `delta.ts`, so this is where the
 * rules that are easy to get subtly wrong — streaks, maxima, and which hands may
 * count towards a "best hand" — are pinned down.
 */
import { describe, expect, it } from 'vitest';
import type { HandEnded } from '../src/history/records';
import { applyDelta, deltasFor, emptyCounters, type PlayerHandDelta } from '../src/stats/delta';

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';

const AT = new Date('2026-09-12T12:00:00Z');

function handEnded(over: Partial<HandEnded> = {}): HandEnded {
  return {
    kind: 'hand-ended',
    handId: '00000000-0000-4000-8000-0000000000ff',
    board: ['14s', '13h', '9d', '4c', '2s'],
    totalPot: 300,
    deckSeed: 'seed',
    bigBlind: 10,
    at: AT,
    players: [
      {
        userId: ALICE,
        seatIndex: 0,
        holeCards: ['14h', '14d'],
        shown: true,
        shownCategory: 'TRIPS',
        endingStack: 1150,
        net: 150,
        wagered: 150,
        potWon: 300,
        wentToShowdown: true,
        won: true,
      },
      {
        userId: BOB,
        seatIndex: 1,
        holeCards: ['9h', '9c'],
        shown: false,
        shownCategory: null,
        endingStack: 850,
        net: -150,
        wagered: 150,
        potWon: 0,
        wentToShowdown: true,
        won: false,
      },
    ],
    ...over,
  };
}

describe('deltasFor', () => {
  it('counts every seat that was dealt in', () => {
    const deltas = deltasFor(handEnded());
    expect(deltas.map((delta) => delta.userId)).toEqual([ALICE, BOB]);
  });

  it('counts one hand into all-time, the month and the week', () => {
    const [alice] = deltasFor(handEnded());
    expect(alice?.periodKeys).toEqual(['alltime', '2026-09', '2026-W37']);
  });

  it('carries the signed net, which is the one counter that can go down', () => {
    const [alice, bob] = deltasFor(handEnded());
    expect(alice?.netChips).toBe(150);
    expect(bob?.netChips).toBe(-150);
  });

  it('counts a mucked showdown as a showdown seen', () => {
    const [, bob] = deltasFor(handEnded());
    expect(bob?.showdownsSeen).toBe(1);
    expect(bob?.showdownsWon).toBe(0);
  });

  /**
   * THE RULE. A mucked hand is its owner's (CLAUDE.md §1), and a public "best
   * hand" statistic built out of cards nobody was shown would be publishing them
   * by another route.
   */
  it('never counts a category for a hand that was not shown', () => {
    const record = handEnded({
      players: [
        {
          userId: BOB,
          seatIndex: 1,
          holeCards: ['9h', '9c'],
          shown: false,
          // Even if the record carried one, it is not this player's to publish.
          shownCategory: 'QUADS',
          endingStack: 850,
          net: -150,
          wagered: 150,
          potWon: 0,
          wentToShowdown: true,
          won: false,
        },
      ],
    });

    expect(deltasFor(record)[0]?.shownCategory).toBeNull();
  });

  it('carries the big blind this hand was played for', () => {
    const [alice] = deltasFor(handEnded({ bigBlind: 50 }));
    expect(alice?.bigBlindSum).toBe(50);
  });
});

describe('applyDelta', () => {
  const delta = (over: Partial<PlayerHandDelta> = {}): PlayerHandDelta => ({
    userId: ALICE,
    periodKeys: ['alltime'],
    at: AT,
    handsPlayed: 1,
    handsWon: 0,
    showdownsSeen: 0,
    showdownsWon: 0,
    netChips: 0,
    totalWagered: 0,
    bigBlindSum: 10,
    potWon: 0,
    shownCategory: null,
    won: false,
    ...over,
  });

  it('adds what is additive', () => {
    let counters = emptyCounters(AT);
    counters = applyDelta(counters, delta({ netChips: 100, totalWagered: 50 }));
    counters = applyDelta(counters, delta({ netChips: -30, totalWagered: 20 }));

    expect(counters.handsPlayed).toBe(2);
    expect(counters.netChips).toBe(70);
    expect(counters.totalWagered).toBe(70);
    expect(counters.bigBlindSum).toBe(20);
  });

  it('keeps the biggest pot rather than the total of them', () => {
    let counters = emptyCounters(AT);
    counters = applyDelta(counters, delta({ potWon: 400, won: true }));
    counters = applyDelta(counters, delta({ potWon: 120, won: true }));

    expect(counters.biggestPot).toBe(400);
  });

  it('keeps the stronger hand, and a tie keeps the earlier date', () => {
    const later = new Date('2026-09-20T12:00:00Z');

    let counters = emptyCounters(AT);
    counters = applyDelta(counters, delta({ shownCategory: 'FLUSH' }));
    expect(counters.bestHandCategory).toBe('FLUSH');
    expect(counters.bestHandAt).toEqual(AT);

    // Weaker: nothing moves.
    counters = applyDelta(counters, delta({ shownCategory: 'PAIR', at: later }));
    expect(counters.bestHandCategory).toBe('FLUSH');
    expect(counters.bestHandAt).toEqual(AT);

    // Equal: the first one you made is the one worth the date.
    counters = applyDelta(counters, delta({ shownCategory: 'FLUSH', at: later }));
    expect(counters.bestHandAt).toEqual(AT);

    // Stronger: it takes over, date and all.
    counters = applyDelta(counters, delta({ shownCategory: 'QUADS', at: later }));
    expect(counters.bestHandCategory).toBe('QUADS');
    expect(counters.bestHandAt).toEqual(later);
  });

  it('counts a streak as hands won in a row, and remembers the high-water mark', () => {
    let counters = emptyCounters(AT);
    for (const won of [true, true, true, false, true]) {
      counters = applyDelta(counters, delta({ won, handsWon: won ? 1 : 0 }));
    }

    expect(counters.handsWon).toBe(4);
    expect(counters.currentWinStreak).toBe(1);
    expect(counters.longestWinStreak).toBe(3);
  });

  it('resets the current streak on a loss without touching the longest', () => {
    let counters = emptyCounters(AT);
    counters = applyDelta(counters, delta({ won: true, handsWon: 1 }));
    counters = applyDelta(counters, delta({ won: true, handsWon: 1 }));
    counters = applyDelta(counters, delta({ won: false }));

    expect(counters.currentWinStreak).toBe(0);
    expect(counters.longestWinStreak).toBe(2);
  });
});
