/**
 * Provable fairness, checked against hands that were actually played.
 *
 * The claim is worth stating precisely, because it is easy to build something
 * that looks like this and proves nothing:
 *
 *   the commitment is published *before* the deal, so the server cannot pick a
 *   seed to suit the cards after seeing them
 *
 *   the seed is published *after*, so nobody can work out the deck while the
 *   hand is live
 *
 *   re-running the shuffle from the published seed reproduces the cards that
 *   were really dealt, including the ones that mucked
 *
 * Each of those has a test here, and so does each way of faking it.
 */
import { describe, expect, it } from 'vitest';
import { createDeck, createSeedRng, seededRng, shuffle } from '@poker/engine';
import type { TableConfig } from '@poker/shared';
import { createMemoryHistorySink } from '../src/history/memory-sink';
import { HistoryRecorder } from '../src/history/recorder';
import type { HistorySink, StoredHand } from '../src/history/sink';
import { commitTo, commitmentHolds, newDeckSeed, verifyHand } from '../src/history/verify';
import type { Connection } from '../src/table/broadcast';
import { DEFAULT_TIMINGS, TableRuntime, type Scheduler } from '../src/table/runtime';

const CONFIG: TableConfig = {
  seatCount: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2_000,
  actionTimeoutSec: 30,
};

const USERS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

interface Played {
  hand: StoredHand;
  sink: HistorySink;
  seeds: string[];
  reveals: { handId: string; deckCommit: string; deckSeed: string }[];
  commitDuringHand: string | null;
}

/** Seat three players, play one hand out, and hand back what was recorded. */
async function playOneHand(): Promise<Played> {
  const scheduler = manualScheduler();
  const sink = createMemoryHistorySink();
  const recorder = new HistoryRecorder({ sink });
  const seeds: string[] = [];
  const reveals: Played['reveals'] = [];

  const table = new TableRuntime({
    code: 'FELT42',
    config: CONFIG,
    rng: seededRng('verify-tests'),
    scheduler,
    hostUserId: USERS[0] ?? null,
    history: recorder,
    deckSeeds: () => {
      // A real 32-byte seed, drawn the way production draws it. Kept only so
      // the test can prove the published one is the one that was used.
      const seed = newDeckSeed();
      seeds.push(seed);
      return seed;
    },
  });

  recorder.record({
    kind: 'table-opened',
    code: 'FELT42',
    hostUserId: USERS[0] ?? null,
    config: CONFIG,
    at: new Date(scheduler.now()),
  });

  const connections = USERS.map((userId) => fakeConnection(userId, reveals));
  for (const [index, connection] of connections.entries()) {
    await table.attach(connection, { displayName: `P${String(index)}`, avatarSeed: null });
    await table.sit(connection.userId, index, 1_000);
    await table.ready(connection.userId);
  }
  await table.whenIdle();
  await scheduler.advance(DEFAULT_TIMINGS.dealDelayMs);
  await table.whenIdle();

  // The commitment is on the table before a card is played.
  const commitDuringHand =
    connections[0]?.latest<{ state: { deckCommit: string | null } }>('state:sync')?.state
      .deckCommit ?? null;

  for (let step = 0; step < 60; step += 1) {
    const prompt = connections[0]?.latest<{
      handId: string;
      seatIndex: number;
      actionSeq: number;
      legalActions: { canCheck: boolean };
    }>('action:prompt');
    if (!prompt || table.state.handId !== prompt.handId) break;
    if (table.state.toActSeat !== prompt.seatIndex) break;

    const actor = connections[prompt.seatIndex];
    if (!actor) break;
    await table.playerAction(actor.userId, {
      handId: prompt.handId,
      actionSeq: prompt.actionSeq,
      type: prompt.legalActions.canCheck ? 'CHECK' : 'CALL',
    });
    await table.whenIdle();
  }

  await scheduler.advance(DEFAULT_TIMINGS.showdownBeatMs);
  await table.whenIdle();
  await recorder.whenFlushed();

  const [hand] = await sink.recentHands('FELT42', 5);
  if (!hand) throw new Error('nothing was recorded');
  return { hand, sink, seeds, reveals, commitDuringHand };
}

function fakeConnection(
  userId: string,
  reveals: { handId: string; deckCommit: string; deckSeed: string }[],
): Connection & { latest<T>(event: string): T | null } {
  const events: { event: string; payload: unknown }[] = [];
  return {
    socketId: `socket-${userId}`,
    userId,
    emit(event, payload) {
      events.push({ event, payload });
      if (event === 'deck:revealed') {
        reveals.push(payload as { handId: string; deckCommit: string; deckSeed: string });
      }
    },
    disconnect() {
      /* nothing to do */
    },
    latest<T>(event: string): T | null {
      const matches = events.filter((entry) => entry.event === event);
      const last = matches[matches.length - 1];
      return last ? (last.payload as T) : null;
    },
  };
}

interface ManualScheduler extends Scheduler {
  advance(ms: number): Promise<void>;
}

function manualScheduler(start = 1_700_000_000_000): ManualScheduler {
  let now = start;
  let tasks: { at: number; run: () => void }[] = [];

  return {
    now: () => now,
    schedule(callback, delayMs) {
      const task = { at: now + delayMs, run: callback };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((candidate) => candidate !== task);
      };
    },
    async advance(ms) {
      now += ms;
      const due = tasks.filter((task) => task.at <= now).sort((a, b) => a.at - b.at);
      tasks = tasks.filter((task) => task.at > now);
      for (const task of due) task.run();
      await Promise.resolve();
    },
  };
}

describe('the commitment', () => {
  it('is on the table before a card is dealt', async () => {
    const played = await playOneHand();

    expect(played.commitDuringHand).toMatch(/^[0-9a-f]{64}$/);
    expect(played.commitDuringHand).toBe(played.hand.deckCommit);
  });

  it('is the hash of the seed that was actually used', async () => {
    const played = await playOneHand();
    const seed = played.seeds[0];
    if (seed === undefined) throw new Error('no seed was drawn');

    expect(played.hand.deckCommit).toBe(commitTo(seed));
    expect(played.hand.deckSeed).toBe(seed);
  });

  it('is published to everyone at the table when the hand ends, and only then', async () => {
    const played = await playOneHand();

    // One reveal each: the seed is no use to a player who did not get it, and
    // it is published once, at the end, not drip-fed during the hand.
    expect(played.reveals).toHaveLength(USERS.length);
    for (const reveal of played.reveals) {
      expect(reveal.deckSeed).toBe(played.seeds[0]);
      expect(reveal.deckCommit).toBe(played.hand.deckCommit);
      expect(reveal.handId).toBe(played.hand.id);
    }
  });

  it('is drawn from 32 bytes, not from something guessable', async () => {
    const played = await playOneHand();
    expect(played.hand.deckSeed).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifying a hand', () => {
  it('reproduces the deal from the published seed', async () => {
    const played = await playOneHand();
    const result = verifyHand(played.hand, USERS[0] ?? null);

    expect(result.reason).toBeNull();
    expect(result.commitmentMatches).toBe(true);
    expect(result.dealMatches).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.deck).toHaveLength(52);
    expect(result.board.matches).toBe(true);
    expect(result.seats).toHaveLength(3);
    expect(result.seats.every((seat) => seat.matches)).toBe(true);
  });

  it('checks a seat that mucked without showing anybody its cards', async () => {
    const played = await playOneHand();
    // Somebody who was not in the hand at all.
    const stranger = '99999999-9999-4999-8999-999999999999';
    const result = verifyHand(played.hand, stranger);

    expect(result.verified).toBe(true);
    for (const seat of result.seats) {
      // Every seat was checked...
      expect(seat.matches).toBe(true);
    }

    const hidden = result.seats.filter((seat) => seat.recorded === null);
    // ...and the ones this reader is not entitled to came back empty.
    expect(hidden.length).toBeGreaterThan(0);
    for (const seat of hidden) expect(seat.computed).toEqual([]);
  });

  it('shows a player their own cards even when they mucked', async () => {
    const played = await playOneHand();
    const mine = played.hand.players[0];
    if (!mine) throw new Error('no players');

    const result = verifyHand(played.hand, mine.userId);
    const seat = result.seats.find((candidate) => candidate.seatIndex === mine.seatIndex);

    expect(seat?.recorded).toHaveLength(2);
    expect(seat?.computed).toEqual(seat?.recorded);
  });

  it('refuses to verify a hand that is still in progress', () => {
    const live: StoredHand = {
      id: '44444444-4444-4444-8444-444444444444',
      tableCode: 'FELT42',
      handNumber: 1,
      buttonSeat: 0,
      smallBlind: 5,
      bigBlind: 10,
      board: [],
      totalPot: 0,
      deckSeed: null,
      deckCommit: 'a'.repeat(64),
      startedAt: new Date(),
      endedAt: null,
      players: [],
      actions: [],
    };

    const result = verifyHand(live, null);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/still in progress/);
    expect(result.deckSeed).toBeNull();
  });

  it('catches a seed swapped for one that does not open the commitment', async () => {
    const played = await playOneHand();
    const tampered: StoredHand = { ...played.hand, deckSeed: newDeckSeed() };

    const result = verifyHand(tampered, USERS[0] ?? null);

    // A different seed deals a different deck, so both halves fail — which is
    // the point: there is no seed that opens this commitment but the real one.
    expect(result.commitmentMatches).toBe(false);
    expect(result.dealMatches).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('catches cards swapped for ones the committed deck never produced', async () => {
    const played = await playOneHand();
    const [first, ...rest] = played.hand.players;
    if (!first) throw new Error('no players');

    const tampered: StoredHand = {
      ...played.hand,
      players: [{ ...first, holeCards: ['14s', '14h'] }, ...rest],
    };

    const result = verifyHand(tampered, first.userId);

    // The commitment still opens — the seed was not touched — and the deal no
    // longer matches it. Checking only the hash would have missed this.
    expect(result.commitmentMatches).toBe(true);
    expect(result.dealMatches).toBe(false);
    expect(result.verified).toBe(false);
  });

  it('catches a board swapped after the fact', async () => {
    const played = await playOneHand();
    if (played.hand.board.length === 0) throw new Error('no board to tamper with');

    const tampered: StoredHand = {
      ...played.hand,
      board: played.hand.board.map(() => '2c'),
    };

    const result = verifyHand(tampered, USERS[0] ?? null);
    expect(result.board.matches).toBe(false);
    expect(result.verified).toBe(false);
  });
});

describe('the commitment scheme itself', () => {
  it('opens for the right seed and nothing else', () => {
    const seed = newDeckSeed();
    expect(commitmentHolds(seed, commitTo(seed))).toBe(true);
    expect(commitmentHolds(newDeckSeed(), commitTo(seed))).toBe(false);
  });

  it('does not fall over on a commitment of the wrong shape', () => {
    expect(commitmentHolds(newDeckSeed(), 'not-a-hash')).toBe(false);
    expect(commitmentHolds(newDeckSeed(), '')).toBe(false);
  });

  it('binds the whole deck, not just the top of it', () => {
    // Two seeds one byte apart give unrelated decks, so committing to a seed
    // commits to all 52 cards and their order.
    const base = 'ab'.repeat(31);
    const one = shuffle(createDeck(), createSeedRng(`${base}00`));
    const other = shuffle(createDeck(), createSeedRng(`${base}01`));

    const asText = (cards: readonly { rank: number; suit: string }[]): string =>
      cards.map((card) => `${String(card.rank)}${card.suit}`).join(' ');
    expect(asText(one)).not.toBe(asText(other));
  });
});
