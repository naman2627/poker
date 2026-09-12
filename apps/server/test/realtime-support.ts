/**
 * A real server, real sockets, real clients.
 *
 * These tests do not stub the transport: they start Fastify on a port, attach
 * Socket.IO to it, and connect socket.io-client to that. What a client receives
 * here is exactly what a browser would receive, which is the only way the
 * "no card ever reaches the wrong player" test is worth anything.
 */
import { seededRng } from '@poker/engine';
import type { Ack, TableConfig } from '@poker/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { attachRealtime } from '../src/realtime';
import { TableRegistry } from '../src/table/registry';
import type { Scheduler, TableTimings } from '../src/table/runtime';
import { createTestAuth, type TestAuth } from './fakes';

export interface CapturedEvent {
  readonly event: string;
  readonly payload: unknown;
  readonly at: number;
}

/** Every payload one socket received, in order, with a way to wait for more. */
export class Recorder {
  readonly events: CapturedEvent[] = [];
  readonly #waiting: {
    predicate: (event: CapturedEvent) => boolean;
    resolve: (e: CapturedEvent) => void;
  }[] = [];

  push(event: CapturedEvent): void {
    this.events.push(event);
    for (const waiter of [...this.#waiting]) {
      if (waiter.predicate(event)) {
        this.#waiting.splice(this.#waiting.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  }

  /** Resolves with the first matching event, past or future. */
  waitFor(predicate: (event: CapturedEvent) => boolean, timeoutMs = 4_000): Promise<CapturedEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      this.#waiting.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiting.indexOf(waiter);
        if (index >= 0) this.#waiting.splice(index, 1);
        reject(new Error('timed out waiting for a socket event'));
      }, timeoutMs);
      timer.unref?.();
    });
  }

  of(event: string): CapturedEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }

  latest<T>(event: string): T | null {
    const matches = this.of(event);
    const last = matches[matches.length - 1];
    return last ? (last.payload as T) : null;
  }
}

export interface TestClient {
  readonly socket: ClientSocket;
  readonly recorder: Recorder;
  readonly userId: string;
  readonly displayName: string;
  emit<T>(event: string, payload?: unknown): Promise<T>;
  /** Like `emit`, but hands back the failure instead of throwing. */
  attempt(event: string, payload?: unknown): Promise<Ack<unknown>>;
  close(): void;
}

export interface TestServer {
  readonly url: string;
  readonly auth: TestAuth;
  readonly registry: TableRegistry;
  createUser(displayName: string): Promise<{ userId: string; token: string }>;
  connect(token: string, userId: string, displayName: string): Promise<TestClient>;
  close(): Promise<void>;
}

/**
 * The table's own pauses, made short.
 *
 * They are real behaviour, not decoration — the showdown beat is the server's,
 * and the deal delay is what keeps players who sat down together in the same
 * hand — so a test cannot skip them. It can only ask for them in milliseconds.
 */
export const FAST_TIMINGS: TableTimings = { showdownBeatMs: 5, dealDelayMs: 5 };

/**
 * A fixed sequence of deck seeds.
 *
 * Production draws 32 random bytes for every hand, which is exactly right there
 * and useless in a test that wants to say anything about the cards. The shuffle
 * is the real one either way — only where the seed comes from changes.
 */
export function seedSequence(prefix = 'realtime'): () => string {
  let nth = 0;
  return () => {
    nth += 1;
    return Buffer.from(`${prefix}-${String(nth)}`.padEnd(32, '.'), 'utf8').toString('hex');
  };
}

export async function startTestServer(
  options: { scheduler?: Scheduler; timings?: TableTimings } = {},
): Promise<TestServer> {
  const auth = createTestAuth();
  const config = loadConfig({ NODE_ENV: 'test' });
  const app = await buildApp(config, auth);
  const registry = new TableRegistry({
    rng: seededRng('realtime-tests'),
    deckSeeds: seedSequence(),
    timings: options.timings ?? FAST_TIMINGS,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  const io = attachRealtime(app, { config, auth, registry });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${String(address.port)}`;

  const clients: TestClient[] = [];
  // Phone numbers only have to be unique, and Math.random is banned repo-wide.
  let nextPhone = 1_000;

  return {
    url,
    auth,
    registry,

    async createUser(displayName: string) {
      nextPhone += 1;
      const user = await auth.users.create({
        phone: `+1415555${String(nextPhone)}`,
        avatarSeed: 'seed',
      });
      await auth.users.updateProfile(user.id, { displayName, email: null });
      const refreshed = await auth.users.findById(user.id);
      if (!refreshed) throw new Error('user vanished');
      const session = await auth.tokens.startSession(refreshed);
      return { userId: user.id, token: session.accessToken };
    },

    async connect(token: string, userId: string, displayName: string) {
      const client = await connectClient(url, token, userId, displayName);
      clients.push(client);
      return client;
    },

    async close() {
      for (const client of clients) client.close();
      registry.closeAll();
      await io.close();
      await app.close();
      await auth.close();
    },
  };
}

export async function connectClient(
  url: string,
  token: string,
  userId: string,
  displayName: string,
): Promise<TestClient> {
  const socket = connect(url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  const recorder = new Recorder();

  socket.onAny((event: string, payload: unknown) => {
    recorder.push({ event, payload, at: Date.now() });
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      reject(error);
    });
  });

  const attempt = (event: string, payload?: unknown): Promise<Ack<unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ack for ${event}`));
      }, 4_000);
      timer.unref?.();
      socket.emit(event, payload ?? {}, (ack: Ack<unknown>) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });

  return {
    socket,
    recorder,
    userId,
    displayName,
    attempt,
    async emit<T>(event: string, payload?: unknown): Promise<T> {
      const ack = await attempt(event, payload);
      if (!ack.ok) throw new Error(`${event} refused: ${ack.error.code} ${ack.error.message}`);
      return ack.data as T;
    },
    close() {
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}

/** The handshake, on its own, for the tests that care about it failing. */
export function connectExpectingFailure(url: string, token: string | null): Promise<Error> {
  return new Promise((resolve, reject) => {
    const socket = connect(url, {
      ...(token === null ? {} : { auth: { token } }),
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    socket.once('connect_error', (error: Error) => {
      socket.disconnect();
      resolve(error);
    });
    socket.once('connect', () => {
      socket.disconnect();
      reject(new Error('the handshake was accepted when it should not have been'));
    });
  });
}

export const TABLE_CONFIG: TableConfig = {
  seatCount: 6,
  smallBlind: 5,
  bigBlind: 10,
  minBuyIn: 200,
  maxBuyIn: 2000,
  actionTimeoutSec: 30,
};
