/**
 * The socket layer itself: who is allowed to connect, what a bad action does to
 * the table (nothing), and what a client gets back after dropping mid-hand.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicTableState } from '@poker/shared';
import { playUntilResult, seatEveryone, startHand } from './realtime-no-leak.test';
import {
  connectExpectingFailure,
  startTestServer,
  TABLE_CONFIG,
  type TestClient,
  type TestServer,
} from './realtime-support';

interface Prompt {
  handId: string;
  seatIndex: number;
  actionSeq: number;
  legalActions: {
    canCheck: boolean;
    canCall: boolean;
    canRaise: boolean;
    minRaiseTo: number;
    maxRaiseTo: number;
  };
  deadlineTs: number;
}

describe('the handshake', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('refuses a connection with no token', async () => {
    const error = await connectExpectingFailure(server.url, null);

    expect(errorData(error).code).toBe('UNAUTHENTICATED');
  });

  it('refuses a token that is not a token', async () => {
    const error = await connectExpectingFailure(server.url, 'not-a-jwt');

    expect(errorData(error).code).toBe('UNAUTHENTICATED');
    expect(errorData(error).message).toMatch(/not valid/);
  });

  it('refuses an expired token', async () => {
    const { token } = await server.createUser('Late');
    server.auth.clock.advance(16 * 60 * 1_000);

    const error = await connectExpectingFailure(server.url, token);

    expect(errorData(error).code).toBe('UNAUTHENTICATED');
  });

  it('lets a signed-in player in', async () => {
    const { userId, token } = await server.createUser('Ana');
    const client = await server.connect(token, userId, 'Ana');

    expect(client.socket.connected).toBe(true);
  });

  it('will not seat a player who has not chosen a name', async () => {
    const user = await server.auth.users.create({ phone: '+14155559090', avatarSeed: 'x' });
    const session = await server.auth.tokens.startSession(user);
    const client = await server.connect(session.accessToken, user.id, '');

    const ack = await client.attempt('table:create', { config: TABLE_CONFIG });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('FORBIDDEN');
  });
});

describe('a table over sockets', () => {
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

  const first = (): TestClient => {
    const client = clients[0];
    if (!client) throw new Error('no client');
    return client;
  };

  const currentPrompt = (): Prompt => {
    const prompt = first().recorder.latest<Prompt>('action:prompt');
    if (!prompt) throw new Error('nobody is on the clock');
    return prompt;
  };

  const actorFor = (prompt: Prompt): TestClient => {
    const client = clients[prompt.seatIndex];
    if (!client) throw new Error('no client in that seat');
    return client;
  };

  it('hands out a six-character code from the unambiguous alphabet', async () => {
    const created = await first().emit<{ code: string }>('table:create', { config: TABLE_CONFIG });

    expect(created.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(created.code).not.toMatch(/[O0I1]/);
  });

  it('refuses a code nobody is playing at', async () => {
    const ack = await first().attempt('table:join', { code: 'ZZZZZZ' });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('NOT_FOUND');
  });

  it('refuses a seat somebody is already in', async () => {
    await seatEveryone(clients);

    const ack = await first().attempt('table:sit', { seatIndex: 1, buyIn: 500 });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.code).toBe('CONFLICT');
  });

  it('refuses a buy-in outside the table limits', async () => {
    const created = await first().emit<{ code: string }>('table:create', { config: TABLE_CONFIG });
    expect(created.code).toHaveLength(6);

    const ack = await first().attempt('table:sit', { seatIndex: 0, buyIn: 10 });

    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.error.message).toMatch(/buy-in must be between/);
  });

  describe('an illegal raise', () => {
    beforeEach(async () => {
      await seatEveryone(clients);
      await startHand(clients);
    });

    it('is rejected, and the table does not move', async () => {
      const prompt = currentPrompt();
      const actor = actorFor(prompt);
      const before = stateOf(first());

      const ack = await actor.attempt('player:action', {
        handId: prompt.handId,
        actionSeq: prompt.actionSeq,
        type: 'RAISE',
        amount: prompt.legalActions.maxRaiseTo + 1,
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) {
        expect(ack.error.code).toBe('INVALID_INPUT');
        expect(ack.error.message).toContain(String(prompt.legalActions.maxRaiseTo));
      }

      const after = stateOf(first());
      expect(after.version).toBe(before.version);
      expect(after.state.toActSeat).toBe(before.state.toActSeat);
      expect(after.state.pots).toEqual(before.state.pots);
      expect(after.state.seats.map((seat) => seat?.stack)).toEqual(
        before.state.seats.map((seat) => seat?.stack),
      );
    });

    it('is rejected below the minimum too, rather than nudged up to it', async () => {
      const prompt = currentPrompt();
      const actor = actorFor(prompt);

      const ack = await actor.attempt('player:action', {
        handId: prompt.handId,
        actionSeq: prompt.actionSeq,
        type: 'RAISE',
        amount: prompt.legalActions.minRaiseTo - 1,
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.message).toMatch(/outside the legal range/);
      // Still that seat's turn: nothing was applied.
      expect(stateOf(first()).state.toActSeat).toBe(prompt.seatIndex);
    });

    it('refuses an action for the wrong hand', async () => {
      const prompt = currentPrompt();
      const ack = await actorFor(prompt).attempt('player:action', {
        handId: '11111111-2222-4333-8444-555555555555',
        actionSeq: prompt.actionSeq,
        type: 'CALL',
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.message).toMatch(/hand is over/);
    });

    it('refuses an action that is out of sequence', async () => {
      const prompt = currentPrompt();
      const ack = await actorFor(prompt).attempt('player:action', {
        handId: prompt.handId,
        actionSeq: prompt.actionSeq + 3,
        type: 'CALL',
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.message).toMatch(/out of date/);
    });

    it('refuses an action from a seat that is not on the clock', async () => {
      const prompt = currentPrompt();
      const outOfTurn = clients[(prompt.seatIndex + 1) % clients.length];
      if (!outOfTurn) throw new Error('no client');

      const ack = await outOfTurn.attempt('player:action', {
        handId: prompt.handId,
        actionSeq: prompt.actionSeq,
        type: 'CALL',
      });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.message).toMatch(/not your turn/);
    });

    it('rate limits a client that will not stop clicking', async () => {
      const prompt = currentPrompt();
      const actor = actorFor(prompt);

      const attempts = await Promise.all(
        Array.from({ length: 14 }, () =>
          actor.attempt('player:action', {
            handId: prompt.handId,
            actionSeq: prompt.actionSeq,
            type: 'CALL',
          }),
        ),
      );

      const limited = attempts.filter((ack) => !ack.ok && ack.error.code === 'RATE_LIMITED');
      expect(limited.length).toBeGreaterThan(0);
    });
  });

  describe('dropping out mid-hand', () => {
    it('gets the same table back, with its own cards, and can keep playing', async () => {
      await seatEveryone(clients);
      await startHand(clients);

      const code = stateOf(first()).state.tableCode;
      const dropped = clients[2];
      if (!dropped) throw new Error('no client');

      const before = stateOf(first());
      const dealtBefore = dropped.recorder.latest<{ yourCards: unknown[] }>('hand:dealt');

      // The socket goes away, but the seat and the hand stay exactly as they were.
      dropped.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const token = (await tokenFor(server, dropped.userId)) ?? '';
      const reconnected = await server.connect(token, dropped.userId, 'Cleo');
      await reconnected.emit('table:join', { code });

      const sync = reconnected.recorder.latest<{ version: number; state: PublicTableState }>(
        'state:sync',
      );
      const dealtAfter = reconnected.recorder.latest<{ yourCards: unknown[] }>('hand:dealt');

      expect(sync?.state.handId).toBe(before.state.handId);
      expect(sync?.version).toBeGreaterThanOrEqual(before.version);
      expect(sync?.state.seats.map((seat) => seat?.stack)).toEqual(
        before.state.seats.map((seat) => seat?.stack),
      );
      // Its own hand came back, and nobody else's did.
      expect(dealtAfter?.yourCards).toEqual(dealtBefore?.yourCards);
      expect(
        sync?.state.seats.filter((seat) => seat !== null && seat.holeCards !== null),
      ).toHaveLength(1);

      // And it is a working socket again: play the same hand out through it.
      clients[2] = reconnected;
      await playUntilResult(clients);
      expect(reconnected.recorder.of('hand:result')).toHaveLength(1);

      reconnected.close();
    });

    it('answers a resync with the whole state, not a patch', async () => {
      await seatEveryone(clients);
      await startHand(clients);

      const client = first();
      const before = client.recorder.of('state:sync').length;
      const answer = await client.emit<{ version: number }>('state:resync', { fromVersion: 0 });

      expect(client.recorder.of('state:sync').length).toBe(before + 1);
      expect(answer.version).toBeGreaterThan(0);
    });
  });

  describe('one socket per user', () => {
    it('replaces the old socket and tells it why', async () => {
      const code = await seatEveryone(clients);
      const original = first();

      const token = (await tokenFor(server, original.userId)) ?? '';
      const second = await server.connect(token, original.userId, 'Ana');
      await second.emit('table:join', { code });

      await original.recorder.waitFor((entry) => entry.event === 'session:replaced');
      expect(original.recorder.of('session:replaced')).toHaveLength(1);

      // The new socket is the live one, and the seat is still theirs.
      const sync = second.recorder.latest<{ state: PublicTableState }>('state:sync');
      expect(sync?.state.viewerSeatIndex).toBe(0);

      second.close();
    });
  });

  describe('chat', () => {
    it('reaches everybody at the table', async () => {
      await seatEveryone(clients);
      await first().emit('chat:send', { text: 'nice hand' });

      for (const client of clients) {
        const message = await client.recorder.waitFor((entry) => entry.event === 'chat:message');
        expect(message.payload).toMatchObject({ text: 'nice hand', displayName: 'Ana' });
      }
    });

    it('refuses an empty message', async () => {
      await seatEveryone(clients);
      const ack = await first().attempt('chat:send', { text: '   ' });

      expect(ack.ok).toBe(false);
      if (!ack.ok) expect(ack.error.code).toBe('INVALID_INPUT');
    });
  });
});

function stateOf(client: TestClient): { version: number; state: PublicTableState } {
  const sync = client.recorder.latest<{ version: number; state: PublicTableState }>('state:sync');
  if (!sync) throw new Error('that client has no state');
  return sync;
}

/** A fresh access token for a user that is already in the fake database. */
async function tokenFor(server: TestServer, userId: string): Promise<string | null> {
  const user = await server.auth.users.findById(userId);
  if (!user) return null;
  const session = await server.auth.tokens.startSession(user);
  return session.accessToken;
}

function errorData(error: Error): { code?: string; message?: string } {
  const data = (error as Error & { data?: unknown }).data;
  return typeof data === 'object' && data !== null ? (data as { code?: string }) : {};
}
