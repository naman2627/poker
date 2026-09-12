/**
 * What the boards say, on the client's side of the wire.
 *
 * Two things are worth holding here. First, that the client formats the same
 * arithmetic the server ranked on — the formulas live in @poker/shared and both
 * sides call them, so a board that ranks by one number and prints another is a
 * failing test rather than a puzzle. Second, that the live board keeps up during
 * a patch.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STAT_CARD,
  MIN_RANKED_HANDS,
  bbPer100,
  handsToQualify,
  metricValue,
  qualifiesFor,
  winRatePercent,
  type PlayerStatCard,
} from '@poker/shared';
import { formatMetric, signedChips } from '../lib/stats/format';
import { applyPatch } from '../lib/store/patch';
import { seat, tableState } from './helpers';

const card = (over: Partial<PlayerStatCard> = {}): PlayerStatCard => ({
  ...EMPTY_STAT_CARD,
  ...over,
});

describe('the formulas', () => {
  it('reads BB/100 as net over the blind, per hundred hands', () => {
    // 10,000 chips over 200 hands at a big blind of 10.
    expect(bbPer100(10_000, 10, 200)).toBeCloseTo(500, 6);
    // Losing is negative, and says so.
    expect(bbPer100(-2_000, 10, 200)).toBeCloseTo(-100, 6);
  });

  it('answers zero rather than infinity when there is nothing to divide by', () => {
    expect(bbPer100(500, 0, 10)).toBe(0);
    expect(bbPer100(500, 10, 0)).toBe(0);
    expect(winRatePercent(3, 0)).toBe(0);
  });

  it('reads a win rate as a percentage of hands played', () => {
    expect(winRatePercent(50, 200)).toBe(25);
  });

  it('gives the same value the server ranked on', () => {
    const stats = card({ handsPlayed: 200, handsWon: 50, netChips: 10_000, bigBlind: 10 });

    expect(metricValue('net', stats)).toBe(10_000);
    expect(metricValue('hands', stats)).toBe(200);
    expect(metricValue('winRate', stats)).toBe(25);
    expect(metricValue('bb100', stats)).toBeCloseTo(500, 6);
  });
});

describe('the two-hundred hand threshold', () => {
  it('applies to the rates and to nothing else', () => {
    expect(qualifiesFor('winRate', 5)).toBe(false);
    expect(qualifiesFor('bb100', 5)).toBe(false);
    expect(qualifiesFor('net', 5)).toBe(true);
    expect(qualifiesFor('hands', 5)).toBe(true);
    expect(qualifiesFor('biggestPot', 5)).toBe(true);
    expect(qualifiesFor('bestHand', 5)).toBe(true);
  });

  it('lets a rate through the moment the count is reached', () => {
    expect(qualifiesFor('bb100', MIN_RANKED_HANDS - 1)).toBe(false);
    expect(qualifiesFor('bb100', MIN_RANKED_HANDS)).toBe(true);
  });

  it('counts down to it, and never past zero', () => {
    expect(handsToQualify(0)).toBe(MIN_RANKED_HANDS);
    expect(handsToQualify(63)).toBe(MIN_RANKED_HANDS - 63);
    expect(handsToQualify(MIN_RANKED_HANDS)).toBe(0);
    expect(handsToQualify(MIN_RANKED_HANDS + 400)).toBe(0);
  });
});

describe('how a metric reads', () => {
  it('puts a sign on the numbers that can go either way', () => {
    expect(signedChips(250)).toBe('+250');
    expect(signedChips(-250)).toBe('-250');
    expect(signedChips(0)).toBe('0');
  });

  it('formats each metric in its own units', () => {
    const stats = card({
      handsPlayed: 200,
      handsWon: 50,
      netChips: 10_000,
      bigBlind: 10,
      biggestPot: 4_200,
      bestHandCategory: 'FULL_HOUSE',
    });

    expect(formatMetric('net', stats)).toBe('+10,000');
    expect(formatMetric('hands', stats)).toBe('200');
    expect(formatMetric('winRate', stats)).toBe('25.0%');
    expect(formatMetric('bb100', stats)).toBe('+500.00');
    expect(formatMetric('biggestPot', stats)).toBe('4,200');
    expect(formatMetric('bestHand', stats)).toBe('Full house');
  });

  it('shows an em dash for a player who has never shown a hand down', () => {
    expect(formatMetric('bestHand', card())).toBe('—');
  });
});

/**
 * The live board on the table, during a patch.
 *
 * A real server sends a whole board with every patch and the store prefers it.
 * What `applyPatch` does is the fallback for the recorded hand, which has no
 * server behind it — and the rule it follows is the same one the rest of that
 * file follows: transcribe a number the server stated, invent nothing.
 */
describe('the live board during a patch', () => {
  const withBoard = () =>
    tableState({
      seats: [seat(0, { stack: 1_000 }), seat(1, { stack: 900 }), seat(2, { stack: 800 })],
      leaderboard: [
        {
          seatIndex: 0,
          userId: seat(0).userId,
          displayName: 'P0',
          avatarSeed: null,
          stack: 1_000,
          net: 0,
          handsWon: 2,
          biggestPot: 400,
        },
        {
          seatIndex: 1,
          userId: seat(1).userId,
          displayName: 'P1',
          avatarSeed: null,
          stack: 900,
          net: -100,
          handsWon: 0,
          biggestPot: 0,
        },
        {
          seatIndex: 2,
          userId: seat(2).userId,
          displayName: 'P2',
          avatarSeed: null,
          stack: 800,
          net: -200,
          handsWon: 1,
          biggestPot: 150,
        },
      ],
    });

  it('moves a stack that the events moved', () => {
    const result = applyPatch(withBoard(), 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'BET', committedThisRound: 300 },
    ]);

    const row = result.state.leaderboard.find((entry) => entry.seatIndex === 0);
    expect(row?.stack).toBe(700);
  });

  it('re-sorts, so the board stays biggest-stack-first', () => {
    const result = applyPatch(withBoard(), 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'BET', committedThisRound: 500 },
    ]);

    expect(result.state.leaderboard.map((entry) => entry.seatIndex)).toEqual([1, 2, 0]);
  });

  it('leaves the per-sitting counters alone, because only the server knows them', () => {
    const result = applyPatch(withBoard(), 0, [
      { type: 'PLAYER_ACTED', seatIndex: 0, action: 'BET', committedThisRound: 300 },
    ]);

    const row = result.state.leaderboard.find((entry) => entry.seatIndex === 0);
    expect(row?.handsWon).toBe(2);
    expect(row?.biggestPot).toBe(400);
    expect(row?.net).toBe(0);
  });

  it('has nothing to do when the table has no board yet', () => {
    const result = applyPatch(tableState({ leaderboard: [] }), 0, [
      { type: 'ACTION_ON', seatIndex: 1 },
    ]);

    expect(result.state.leaderboard).toEqual([]);
  });
});
