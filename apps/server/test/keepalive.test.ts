/**
 * The keep-alive pings.
 *
 * Both the timer and `fetch` are injected, so these are ordinary synchronous
 * assertions: nothing waits fourteen minutes and nothing leaves the machine.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  KEEPALIVE_INTERVAL_MS,
  keepAliveUrlFrom,
  startKeepAlive,
  type KeepAliveOptions,
} from '../src/keepalive';

/** The injected fetch, typed, so `mock.calls[0]` knows it has a url in it. */
type PingFetch = NonNullable<KeepAliveOptions['fetch']>;

/** A stand-in for setInterval whose callback this test fires by hand. */
function fakeSchedule() {
  let callback: (() => void) | null = null;
  let delayMs: number | null = null;
  let cancelled = false;

  return {
    schedule: (cb: () => void, delay: number) => {
      callback = cb;
      delayMs = delay;
      return {
        cancel: () => {
          cancelled = true;
        },
      };
    },
    tick: () => {
      if (callback === null) throw new Error('nothing was scheduled');
      callback();
    },
    get delayMs() {
      return delayMs;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

const ok: PingFetch = () => Promise.resolve({ ok: true, status: 200 });

describe('startKeepAlive', () => {
  it('pings its own /health on the interval', async () => {
    const timer = fakeSchedule();
    const fetch = vi.fn<PingFetch>(ok);

    startKeepAlive({
      url: 'https://poker-server.onrender.com',
      fetch,
      schedule: timer.schedule,
    });

    expect(fetch).not.toHaveBeenCalled(); // nothing on boot — it is plainly awake
    timer.tick();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://poker-server.onrender.com/health');
  });

  it('stays inside the fifteen minutes a free Render instance is given', () => {
    const timer = fakeSchedule();
    startKeepAlive({ url: 'https://x.onrender.com', fetch: ok, schedule: timer.schedule });

    expect(timer.delayMs).toBe(KEEPALIVE_INTERVAL_MS);
    expect(KEEPALIVE_INTERVAL_MS).toBeLessThan(15 * 60 * 1000);
  });

  it('does not double the slash when the url already ends in one', async () => {
    const timer = fakeSchedule();
    const fetch = vi.fn<PingFetch>(ok);

    startKeepAlive({ url: 'https://x.onrender.com/', fetch, schedule: timer.schedule });
    timer.tick();

    await vi.waitFor(() => {
      expect(fetch.mock.calls[0]?.[0]).toBe('https://x.onrender.com/health');
    });
  });

  it('survives a ping that fails, and keeps its timer', async () => {
    const timer = fakeSchedule();
    const warn = vi.fn();
    const fetch = vi.fn<PingFetch>(() => Promise.reject(new Error('ECONNREFUSED')));

    startKeepAlive({
      url: 'https://x.onrender.com',
      fetch,
      schedule: timer.schedule,
      logger: { warn },
    });

    // A throw out of a timer callback would take the process down with it.
    expect(() => {
      timer.tick();
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledOnce();
    });

    timer.tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timer.cancelled).toBe(false);
  });

  it('logs a refusal without treating it as fatal', async () => {
    const timer = fakeSchedule();
    const warn = vi.fn();

    startKeepAlive({
      url: 'https://x.onrender.com',
      fetch: () => Promise.resolve({ ok: false, status: 502 }),
      schedule: timer.schedule,
      logger: { warn },
    });
    timer.tick();

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ status: 502 }),
        expect.any(String),
      );
    });
  });

  it('stops pinging once it is stopped, so shutdown is not held open', async () => {
    const timer = fakeSchedule();
    const fetch = vi.fn<PingFetch>(ok);

    const stop = startKeepAlive({
      url: 'https://x.onrender.com',
      fetch,
      schedule: timer.schedule,
    });

    stop();
    expect(timer.cancelled).toBe(true);

    // Even a callback already in flight when stop landed must do nothing.
    timer.tick();
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('keepAliveUrlFrom', () => {
  it('uses the URL Render sets on every service it runs', () => {
    expect(keepAliveUrlFrom({ RENDER_EXTERNAL_URL: 'https://poker-server.onrender.com' })).toBe(
      'https://poker-server.onrender.com',
    );
  });

  it('lets KEEPALIVE_URL win, for anywhere that is not Render', () => {
    expect(
      keepAliveUrlFrom({
        KEEPALIVE_URL: 'https://elsewhere.example.com',
        RENDER_EXTERNAL_URL: 'https://poker-server.onrender.com',
      }),
    ).toBe('https://elsewhere.example.com');
  });

  it('is off when nothing is configured, so a laptop never pings anything', () => {
    expect(keepAliveUrlFrom({})).toBeNull();
  });

  it('treats a blank KEEPALIVE_URL as unset and falls back', () => {
    // Render writes an empty string for a blueprint field left alone, which is
    // exactly what a `??` chain would mistake for a configured value.
    expect(
      keepAliveUrlFrom({ KEEPALIVE_URL: '', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }),
    ).toBe('https://x.onrender.com');
    expect(
      keepAliveUrlFrom({ KEEPALIVE_URL: '   ', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }),
    ).toBe('https://x.onrender.com');
  });

  it('is off when both are blank rather than pointing pings at nothing', () => {
    expect(keepAliveUrlFrom({ KEEPALIVE_URL: '', RENDER_EXTERNAL_URL: '' })).toBeNull();
  });

  it('is off on request, for a paid instance that does not sleep', () => {
    expect(
      keepAliveUrlFrom({ KEEPALIVE_URL: 'off', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }),
    ).toBeNull();
  });
});
