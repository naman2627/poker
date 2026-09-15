/**
 * Keeping a free instance awake.
 *
 * Render puts a free web service to sleep after fifteen minutes with no inbound
 * request, and waking it takes the better part of a minute. For most apps that
 * is a slow first page load. Here it is worse than that: every live table is
 * held in this process, so a spin-down ends every hand in progress and drops
 * everybody sitting at a table.
 *
 * So the server keeps itself awake by asking its own public URL for /health on
 * a timer set inside that window. The request leaves the platform and comes
 * back in, which is what makes it count as the inbound traffic the idle check
 * is looking for — an internal call to 127.0.0.1 would not.
 *
 * Two things this is not:
 *
 * - It is not a wake-up. A process that is already asleep is not running this
 *   timer, so nothing here can bring it back; only a real visitor does that.
 *   This prevents the sleep, it does not cure it.
 * - It is not a health check. Nothing reads the answer beyond logging a failure,
 *   and a failed ping changes no behaviour. `/health` is simply the cheapest
 *   endpoint that proves the round trip happened.
 *
 * Off unless a public URL is configured, so local development and the tests
 * never make a network call.
 */

/** Fourteen minutes: inside Render's fifteen, with a minute of slack. */
export const KEEPALIVE_INTERVAL_MS = 14 * 60 * 1000;

export interface KeepAliveLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface KeepAliveOptions {
  /** The service's own public origin, e.g. https://poker-server.onrender.com. */
  readonly url: string;
  readonly intervalMs?: number;
  readonly logger?: KeepAliveLogger;
  /** Injected by tests so nothing leaves the machine. */
  readonly fetch?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>;
  /** Injected by tests so nothing waits out fourteen minutes. */
  readonly schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
}

/**
 * Starts the timer. Returns a stop function; shutdown calls it so a pending
 * timer cannot hold the process open.
 *
 * The first ping is deliberately one interval away rather than immediate: the
 * instance is plainly awake at the moment it boots, and a request issued while
 * it is still binding its port is a log line about a connection refused.
 */
export function startKeepAlive(options: KeepAliveOptions): () => void {
  const intervalMs = options.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const target = `${options.url.replace(/\/+$/, '')}/health`;

  const doFetch =
    options.fetch ??
    ((url, init) => globalThis.fetch(url, init).then((r) => ({ ok: r.ok, status: r.status })));

  const schedule =
    options.schedule ??
    ((callback, delayMs) => {
      const timer = setInterval(callback, delayMs);
      timer.unref?.();
      return {
        cancel: () => {
          clearInterval(timer);
        },
      };
    });

  let stopped = false;

  const ping = (): void => {
    if (stopped) return;

    // Bounded: a ping that hangs must not still be outstanding when the next
    // one is due, or a stalled network would pile them up for the life of the
    // process.
    void doFetch(target, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.min(30_000, intervalMs / 2)),
    })
      .then((response) => {
        if (!response.ok) {
          options.logger?.warn({ status: response.status, target }, 'keep-alive ping was refused');
        }
      })
      .catch((error: unknown) => {
        // Never fatal. A missed ping costs at most one spin-down, and throwing
        // out of a timer would take the server with it.
        options.logger?.warn(
          { err: error instanceof Error ? error.message : String(error), target },
          'keep-alive ping failed',
        );
      });
  };

  const timer = schedule(ping, intervalMs);

  return () => {
    stopped = true;
    timer.cancel();
  };
}

/**
 * The URL to ping, or null to leave the whole thing off.
 *
 * Render sets `RENDER_EXTERNAL_URL` on every service it runs, so on Render this
 * needs no configuration at all. `KEEPALIVE_URL` overrides it for anywhere else
 * that sleeps the same way, and setting `KEEPALIVE_URL=off` turns it off on a
 * platform that does not — a paid instance has no idle timeout, and pinging it
 * every fourteen minutes is just noise in the log.
 */
export function keepAliveUrlFrom(env: {
  KEEPALIVE_URL?: string | undefined;
  RENDER_EXTERNAL_URL?: string | undefined;
}): string | null {
  // Blank counts as unset, not as a URL. A dashboard that offers a field for
  // this one and is left alone hands over an empty string rather than nothing,
  // and `??` would take it — leaving the pings aimed at "".
  const explicit = env.KEEPALIVE_URL?.trim();
  if (explicit === 'off') return null;
  if (explicit) return explicit;

  const platform = env.RENDER_EXTERNAL_URL?.trim();
  return platform ? platform : null;
}
