import type { Ack } from '@poker/shared';

/**
 * The one shape the store talks to.
 *
 * There are two implementations: a Socket.IO client, and a fixture that replays
 * a recorded hand. The store cannot tell them apart, which is the point — the
 * fixture exercises the same code path the real server will, rather than a
 * parallel "demo mode" that quietly diverges from it.
 */
export interface Transport {
  readonly kind: 'socket' | 'fixture';
  /** Server-to-client frames, exactly as they came off the wire. */
  subscribe(listener: TransportListener): () => void;
  /** Client-to-server, with the server's acknowledgement. */
  emit<T>(event: string, payload?: unknown): Promise<Ack<T>>;
  close(): void;
}

export type TransportListener = (frame: TransportFrame) => void;

export type TransportFrame =
  /** Connected, and every prior subscription re-established. */
  | { readonly kind: 'open'; readonly reconnected: boolean }
  /** The link dropped and the client is trying to get it back. */
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly nextDelayMs: number }
  /** Gone, and not coming back on its own. */
  | { readonly kind: 'closed'; readonly reason: string }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | { readonly kind: 'event'; readonly event: string; readonly payload: unknown };
