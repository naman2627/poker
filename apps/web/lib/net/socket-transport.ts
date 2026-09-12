import { io, type Socket } from 'socket.io-client';
import { SERVER_EVENTS, type Ack } from '@poker/shared';
import { SERVER_URL } from '../env';
import type { Transport, TransportFrame, TransportListener } from './transport';

/**
 * Socket.IO, wrapped so the store never imports it.
 *
 * The access token rides in the handshake, which is where the server looks for
 * it. Every emit is acknowledged: the server answers a refusal with a typed
 * error rather than throwing, so a rejected action comes back on the same call
 * that sent it and the UI has something specific to say.
 *
 * Reconnection is the library's, configured rather than reimplemented: it backs
 * off from half a second to ten, doubling each time, and keeps trying. A player
 * whose train goes into a tunnel gets their table back without a page reload,
 * and the seat is still theirs because the server keeps it (see
 * `TableRuntime.detach`).
 *
 * What this file will *not* do is hide the state of the link. Every attempt is
 * announced, because a client that quietly retries while the buttons still look
 * alive is how a player thinks they folded when they did not.
 */
const SERVER_EVENT_NAMES = Object.values(SERVER_EVENTS);

/** Long enough for a slow round trip; short enough that a dead link is noticed. */
const ACK_TIMEOUT_MS = 8_000;

const BACKOFF = {
  initialMs: 500,
  maxMs: 10_000,
  /** Doubling, with a little jitter so a restarted server is not stampeded. */
  factor: 2,
  jitter: 0.3,
} as const;

export function createSocketTransport(token: string): Transport {
  const socket: Socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket'],
    withCredentials: true,
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: BACKOFF.initialMs,
    reconnectionDelayMax: BACKOFF.maxMs,
    randomizationFactor: BACKOFF.jitter,
    timeout: ACK_TIMEOUT_MS,
  });

  const listeners = new Set<TransportListener>();
  const publish = (frame: TransportFrame): void => {
    for (const listener of listeners) listener(frame);
  };

  let hasConnected = false;
  let closedByUs = false;

  socket.on('connect', () => {
    const reconnected = hasConnected;
    hasConnected = true;
    publish({ kind: 'open', reconnected });
  });

  socket.on('disconnect', (reason: string) => {
    if (closedByUs) return;

    // Socket.IO reconnects on its own for everything except a deliberate
    // shutdown at one end or the other. Saying which of the two this was is the
    // difference between "hold on" and "you are not coming back".
    const willRetry = reason !== 'io client disconnect' && reason !== 'io server disconnect';
    publish(
      willRetry
        ? { kind: 'reconnecting', attempt: 0, nextDelayMs: BACKOFF.initialMs }
        : { kind: 'closed', reason },
    );
  });

  socket.io.on('reconnect_attempt', (attempt: number) => {
    publish({ kind: 'reconnecting', attempt, nextDelayMs: delayFor(attempt) });
  });

  socket.on('connect_error', (error: Error & { data?: { code?: string; message?: string } }) => {
    // A refused handshake is not a network blip: the token is wrong or expired,
    // and retrying with the same one will keep being wrong.
    if (error.data?.code === 'UNAUTHENTICATED') {
      socket.io.reconnection(false);
      publish({ kind: 'error', code: 'UNAUTHENTICATED', message: error.data.message ?? '' });
      return;
    }
    if (!hasConnected) {
      publish({ kind: 'reconnecting', attempt: 0, nextDelayMs: BACKOFF.initialMs });
    }
  });

  for (const event of SERVER_EVENT_NAMES) {
    socket.on(event, (payload: unknown) => {
      publish({ kind: 'event', event, payload });
    });
  }

  return {
    kind: 'socket',

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    emit<T>(event: string, payload?: unknown): Promise<Ack<T>> {
      // Before the first connection, Socket.IO buffering is exactly right: the
      // handshake is in flight and the ack timeout below bounds the wait. After
      // a drop it is exactly wrong — a buffered fold would arrive whenever the
      // link came back, long after the hand it belonged to.
      if (hasConnected && !socket.connected) {
        return Promise.resolve({
          ok: false,
          error: { code: 'INTERNAL', message: 'not connected to the table' },
        });
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({
            ok: false,
            error: { code: 'INTERNAL', message: 'the server did not answer in time' },
          });
        }, ACK_TIMEOUT_MS);

        socket.emit(event, payload ?? {}, (ack: Ack<T>) => {
          clearTimeout(timer);
          resolve(ack);
        });
      });
    },

    close() {
      closedByUs = true;
      listeners.clear();
      socket.close();
    },
  };
}

/** What the library will wait before attempt `n`, for the UI to count down. */
function delayFor(attempt: number): number {
  const raw = BACKOFF.initialMs * Math.pow(BACKOFF.factor, Math.max(0, attempt - 1));
  return Math.min(BACKOFF.maxMs, Math.round(raw));
}
