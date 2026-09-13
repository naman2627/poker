/**
 * THE test (CLAUDE.md §1).
 *
 * Four clients play a hand out to a showdown over real sockets, and every
 * payload every one of them receives is kept. Then, for each client, the whole
 * stream is replayed in order and every card in it must be one the client was
 * entitled to see *at that moment*: its own, one on the board, or one a showdown
 * had already turned face up.
 *
 * If this test ever fails, no other test in this repo matters.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublicTableStateSchema, type PublicTableState } from '@poker/shared';
import {
  startTestServer,
  TABLE_CONFIG,
  type CapturedEvent,
  type TestClient,
  type TestServer,
} from './realtime-support';

interface Prompt {
  handId: string;
  seatIndex: number;
  actionSeq: number;
  legalActions: { canCheck: boolean; canCall: boolean };
  deadlineTs: number;
}

describe('a full four-player hand over sockets', () => {
  let server: TestServer;
  let clients: TestClient[] = [];

  beforeEach(async () => {
    server = await startTestServer();
    clients = [];

    for (const name of ['Ana', 'Ben', 'Cleo', 'Dev']) {
      const { userId, token } = await server.createUser(name);
      clients.push(await server.connect(token, userId, name));
    }
  });

  afterEach(async () => {
    await server.close();
  });

  it('never shows a player a card that was not theirs', async () => {
    const code = await seatEveryone(clients);
    await dealAndPlayToShowdown(clients);

    // The hand really did reach a showdown, or this test proves nothing. Two or
    // more hands got there; whether they were shown or mucked is the showdown's
    // business, and a mucked one is the more interesting case for a leak.
    const result = clients[0]?.recorder.latest<{
      revealed: unknown[];
      mucked: unknown[];
    }>('hand:result');
    expect((result?.revealed.length ?? 0) + (result?.mucked.length ?? 0)).toBeGreaterThanOrEqual(2);
    expect(code).toHaveLength(6);

    for (const client of clients) {
      const own = ownHand(client);
      const publicCards = new Set<string>();

      for (const entry of client.recorder.events) {
        // Whatever this payload itself makes public counts from here on: the
        // board as it is dealt, and the hands a showdown turns over. A seat's
        // cards inside a state payload never make themselves public, so a leak
        // has nowhere to hide.
        for (const card of newlyPublicCards(entry)) publicCards.add(card);

        for (const card of cardsIn(entry.payload)) {
          expect(
            own.cards.has(card) || publicCards.has(card),
            `${client.displayName} saw ${card} in ${entry.event}, which was not theirs to see`,
          ).toBe(true);
        }
      }

      // Two of their own, and the whole board, is what a player should end with.
      expect(own.cards.size).toBe(2);
      expect(publicCards.size).toBeGreaterThanOrEqual(5);
    }
  });

  it("never lets one player see another player's hand before the showdown", async () => {
    await seatEveryone(clients);
    await dealAndPlayToShowdown(clients);

    // Ground truth: what the server privately dealt to each socket.
    const hands = clients.map((client) => ownHand(client));

    for (const [index, client] of clients.entries()) {
      const theirs = hands[index];
      if (!theirs) throw new Error('no hand');
      const others = new Set(
        hands.filter((_, other) => other !== index).flatMap((hand) => [...hand.cards]),
      );

      let showdownReached = false;
      for (const entry of client.recorder.events) {
        if (revealsHands(entry)) showdownReached = true;

        for (const card of cardsIn(entry.payload)) {
          if (!others.has(card)) continue;
          expect(
            showdownReached,
            `${client.displayName} saw another hand's ${card} in ${entry.event} before the showdown`,
          ).toBe(true);
        }
      }

      // The showdown did happen, and their own hand was never in doubt.
      expect(showdownReached).toBe(true);
      expect(theirs.cards.size).toBe(2);
    }
  });

  it('sends every seat exactly two private cards, and nobody else theirs', async () => {
    await seatEveryone(clients);
    await startHand(clients);

    const dealt = clients.map((client) =>
      client.recorder.latest<{ yourCards: unknown[]; seatIndex: number }>('hand:dealt'),
    );

    expect(dealt.every((payload) => payload?.yourCards.length === 2)).toBe(true);
    expect(new Set(dealt.map((payload) => payload?.seatIndex)).size).toBe(4);

    // Every pair is different, and no client received anybody else's pair.
    const pairs = dealt.map((payload) => [...cardsIn(payload)].sort().join('|'));
    expect(new Set(pairs).size).toBe(4);
  });

  it('hides other seats behind a card count while the hand is live', async () => {
    await seatEveryone(clients);
    await startHand(clients);

    const client = clients[0];
    if (!client) throw new Error('no client');
    const sync = client.recorder.latest<{ state: PublicTableState }>('state:sync');
    const state = PublicTableStateSchema.parse(sync?.state);

    const mine = state.seats.find((seat) => seat?.seatIndex === state.viewerSeatIndex);
    const others = state.seats.filter(
      (seat) => seat !== null && seat.seatIndex !== state.viewerSeatIndex,
    );

    expect(mine?.holeCards).toHaveLength(2);
    expect(others).toHaveLength(3);
    for (const seat of others) {
      expect(seat?.holeCards).toBeNull();
      expect(seat?.cardCount).toBe(2);
    }
  });

  /**
   * THE SPECTATOR CASE (CLAUDE.md §1).
   *
   * Somebody joins the table and never sits. They are present for a whole hand,
   * from the deal to the showdown, and every payload they receive is checked
   * against one rule: the only cards they may ever see are the board, and the
   * hands the showdown actually turned face up.
   *
   * The two things that would be easy to get wrong are both asserted directly —
   * they are never dealt a private hand of their own, and a seat that mucked
   * stays mucked for them exactly as it does for everybody else. A watcher is
   * not a privileged reader.
   */
  it('shows a spectator the board and the shown hands, and not one card more', async () => {
    const code = await seatEveryone(clients);

    const { userId, token } = await server.createUser('Wren');
    const watcher = await server.connect(token, userId, 'Wren');
    await watcher.emit('table:join', { code });

    await dealAndPlayToShowdown(clients);
    // Let the showdown and the payout reach the rail as well as the table.
    await watcher.recorder.waitFor((entry) => entry.event === 'hand:result');

    // A watcher has no hand, and is never told they have one. This is the
    // assertion that matters: `hand:dealt` is the only payload in the system
    // that carries somebody's private cards, and it is addressed to one socket.
    expect(watcher.recorder.latest('hand:dealt')).toBeNull();

    const sync = watcher.recorder.latest<{ state: PublicTableState }>('state:sync');
    const state = PublicTableStateSchema.parse(sync?.state);
    expect(state.viewerSeatIndex).toBeNull();

    // Prompts are broadcast rather than addressed — every client gets them so it
    // can draw the clock over whichever seat is thinking, and the deadline is in
    // the public state anyway. None of them carries a card, and none of them is
    // this watcher's to answer: the server refuses an action from a seatless
    // socket regardless of what it was sent.
    const prompt = watcher.recorder.latest<{ handId: string; actionSeq: number }>('action:prompt');
    const refused = await watcher.attempt('player:action', {
      handId: prompt?.handId ?? state.handId,
      actionSeq: prompt?.actionSeq ?? 0,
      type: 'FOLD',
    });
    expect(refused.ok).toBe(false);

    // What the showdown made public, from the table's own point of view.
    const result = clients[0]?.recorder.latest<{
      revealed: { cards: unknown }[];
      mucked: unknown[];
    }>('hand:result');
    const shown = new Set((result?.revealed ?? []).flatMap((reveal) => [...cardsIn(reveal.cards)]));

    // Replay the rail's whole stream. Every card in it has to be public by the
    // time it arrives, on exactly the terms a seated player gets.
    const publicCards = new Set<string>();
    let sawACard = false;

    for (const entry of watcher.recorder.events) {
      for (const card of newlyPublicCards(entry)) publicCards.add(card);

      for (const card of cardsIn(entry.payload)) {
        sawACard = true;
        expect(
          publicCards.has(card),
          `a spectator saw ${card} in ${entry.event}, which was not public yet`,
        ).toBe(true);
      }
    }

    // The board reached them, so the check above was not vacuous.
    expect(sawACard).toBe(true);
    expect(publicCards.size).toBeGreaterThanOrEqual(5);

    /*
     * THE MUCK, from the rail.
     *
     * A hand that reached the showdown and was not turned over stays its
     * owner's — and a spectator is not a privileged reader. The cards are taken
     * from what the server privately dealt each seated client, so this compares
     * against ground truth rather than against anything the watcher was told.
     */
    const everySeenCard = new Set<string>();
    for (const entry of watcher.recorder.events) {
      for (const card of cardsIn(entry.payload)) everySeenCard.add(card);
    }

    const muckedSeats = new Set(
      (result?.mucked ?? []).map((muck) => (muck as { seatIndex: number }).seatIndex),
    );

    for (const client of clients) {
      const dealt = client.recorder.latest<{ seatIndex: number; yourCards: unknown }>('hand:dealt');
      if (!dealt || !muckedSeats.has(dealt.seatIndex)) continue;

      for (const card of cardsIn(dealt.yourCards)) {
        expect(
          everySeenCard.has(card),
          `a spectator saw ${card}, which belonged to seat ${String(dealt.seatIndex)} and was mucked`,
        ).toBe(false);
      }
    }

    // Whatever the showdown did turn over, the rail did see — otherwise the
    // check above would pass on a hand that showed nothing to anybody.
    for (const card of shown) {
      expect(everySeenCard.has(card), `a spectator missed ${card}, which was shown down`).toBe(
        true,
      );
    }
    expect(shown.size).toBeGreaterThanOrEqual(2);
  });

  it('never puts the deck on the wire', async () => {
    await seatEveryone(clients);
    await dealAndPlayToShowdown(clients);

    for (const client of clients) {
      for (const entry of client.recorder.events) {
        const serialised = JSON.stringify(entry.payload);
        expect(serialised).not.toContain('"deck"');
        expect(entry.event).not.toBe('state:deck');
      }
      // What a client gets instead is a count.
      const sync = client.recorder.latest<{ state: PublicTableState }>('state:sync');
      expect(typeof sync?.state.deckRemaining).toBe('number');
    }
  });

  it('gives every table update a version that only ever goes up', async () => {
    await seatEveryone(clients);
    await dealAndPlayToShowdown(clients);

    for (const client of clients) {
      const versions = client.recorder.events
        .filter((entry) => entry.event === 'state:sync' || entry.event === 'state:patch')
        .map((entry) => (entry.payload as { version: number }).version);

      expect(versions.length).toBeGreaterThan(4);
      for (let i = 1; i < versions.length; i += 1) {
        expect(versions[i] ?? 0).toBeGreaterThanOrEqual(versions[i - 1] ?? 0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Driving a hand                                                      *
 * ------------------------------------------------------------------ */

export async function seatEveryone(clients: TestClient[]): Promise<string> {
  const host = clients[0];
  if (!host) throw new Error('no clients');

  const created = await host.emit<{ code: string }>('table:create', { config: TABLE_CONFIG });
  for (const client of clients.slice(1)) {
    await client.emit('table:join', { code: created.code });
  }

  for (const [index, client] of clients.entries()) {
    await client.emit('table:sit', { seatIndex: index, buyIn: 1_000 });
  }

  return created.code;
}

export async function startHand(clients: TestClient[]): Promise<void> {
  for (const client of clients) await client.emit('player:ready');

  // The last ready deals the hand; everybody's private cards follow it.
  for (const client of clients) {
    await client.recorder.waitFor((entry) => entry.event === 'hand:dealt');
  }
}

/**
 * Check when checking is free, call when it is not, and never fold — which
 * takes four players all the way to a showdown, where the interesting question
 * about who can see what finally gets asked.
 */
export async function dealAndPlayToShowdown(clients: TestClient[]): Promise<void> {
  await startHand(clients);
  await playUntilResult(clients);
}

/**
 * Play out whatever hand is running, from wherever it has got to.
 *
 * It follows `actionSeq` rather than counting prompts, so it can pick a hand up
 * in the middle — which is exactly what the reconnect test needs it to do.
 */
export async function playUntilResult(clients: TestClient[]): Promise<void> {
  const watcher = clients[0];
  if (!watcher) throw new Error('no clients');

  const actedOn = new Set<string>();
  const keyOf = (prompt: Prompt): string => `${prompt.handId}:${String(prompt.actionSeq)}`;

  for (let step = 0; step < 60; step += 1) {
    if (watcher.recorder.of('hand:result').length > 0) break;

    const prompt = watcher.recorder.latest<Prompt>('action:prompt');
    if (!prompt || actedOn.has(keyOf(prompt))) {
      await Promise.race([
        watcher.recorder.waitFor(
          (entry) =>
            entry.event === 'action:prompt' && !actedOn.has(keyOf(entry.payload as Prompt)),
        ),
        watcher.recorder.waitFor((entry) => entry.event === 'hand:result'),
      ]);
      continue;
    }

    actedOn.add(keyOf(prompt));
    const actor = clients[prompt.seatIndex];
    if (!actor) throw new Error(`no client in seat ${String(prompt.seatIndex)}`);

    await actor.emit('player:action', {
      handId: prompt.handId,
      actionSeq: prompt.actionSeq,
      type: prompt.legalActions.canCheck ? 'CHECK' : 'CALL',
    });
  }

  // Every client, not just the one driving: the assertions read all four
  // streams, so all four have to have caught up.
  for (const client of clients) {
    await client.recorder.waitFor((entry) => entry.event === 'hand:result');
  }
}

/* ------------------------------------------------------------------ *
 * Reading cards out of a payload                                      *
 * ------------------------------------------------------------------ */

/** Every card anywhere in a payload, however deeply it is buried. */
export function cardsIn(value: unknown): Set<string> {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;

    const record = node as Record<string, unknown>;
    if (typeof record.rank === 'number' && typeof record.suit === 'string') {
      found.add(`${String(record.rank)}${record.suit}`);
      return;
    }
    for (const item of Object.values(record)) walk(item);
  };

  walk(value);
  return found;
}

/**
 * The hand the server dealt this socket, taken from the private `hand:dealt`
 * that only that socket received — and cross-checked against every state
 * payload, so a server that lied about which seat the viewer is in would be
 * caught here rather than quietly excused.
 */
function ownHand(client: TestClient): { seatIndex: number; cards: Set<string> } {
  const dealt = client.recorder.latest<{ seatIndex: number; yourCards: unknown }>('hand:dealt');
  if (!dealt) throw new Error(`${client.displayName} was never dealt in`);

  const cards = cardsIn(dealt.yourCards);
  expect(cards.size).toBe(2);

  for (const entry of client.recorder.of('state:sync')) {
    const state = (entry.payload as { state: PublicTableState }).state;
    if (state.handId === null) continue;
    expect(state.viewerSeatIndex).toBe(dealt.seatIndex);

    const mine = state.seats.find((seat) => seat?.seatIndex === dealt.seatIndex);
    if (mine?.holeCards) {
      expect(new Set(cardsIn(mine.holeCards))).toEqual(cards);
    }
  }

  return { seatIndex: dealt.seatIndex, cards };
}

/** Whether this payload is the moment the hands went face up. */
function revealsHands(entry: CapturedEvent): boolean {
  if (entry.event === 'hand:result') return true;
  if (entry.event !== 'state:patch') return false;

  return asArray((entry.payload as { events?: unknown }).events).some(
    (event) => (event as { type?: unknown }).type === 'HAND_REVEALED',
  );
}

/**
 * Cards this payload makes public — the board as it is dealt, and the hands a
 * showdown turns over. Note what is *not* here: a seat's `holeCards` inside a
 * state payload never makes itself public, so a leaked card has nowhere to hide.
 */
function newlyPublicCards(entry: CapturedEvent): Set<string> {
  const cards = new Set<string>();
  const payload = entry.payload as Record<string, unknown>;

  if (entry.event === 'state:sync') {
    const state = payload.state as { board?: unknown } | undefined;
    for (const card of cardsIn(state?.board)) cards.add(card);
  }

  if (entry.event === 'state:patch') {
    for (const event of asArray(payload.events)) {
      const record = event as { type?: unknown; cards?: unknown };
      if (record.type === 'BOARD_DEALT' || record.type === 'HAND_REVEALED') {
        for (const card of cardsIn(record.cards)) cards.add(card);
      }
    }
  }

  if (entry.event === 'hand:result') {
    for (const reveal of asArray(payload.revealed)) {
      for (const card of cardsIn((reveal as { cards?: unknown }).cards)) cards.add(card);
    }
  }

  return cards;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
