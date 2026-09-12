'use client';

import { CLIENT_EVENTS, type Ack } from '@poker/shared';
import {
  DEADLINE,
  FIXTURE_CONFIG,
  FIXTURE_TABLE_CODE,
  SCRIPT,
  type ScriptFrame,
} from '../../fixtures/scripted-hand';
import type { Transport, TransportFrame, TransportListener } from './transport';

/**
 * The recorded hand, played back down the same pipe a socket would use.
 *
 * The store cannot tell this from `createSocketTransport`, which is what makes
 * the fixture worth having: it exercises the real reducer, the real components
 * and the real acknowledgement round trip, rather than a demo mode that would
 * drift away from them.
 *
 * Two things it does that a socket does not:
 *
 *   it stamps deadlines — the action clock is absolute epoch milliseconds, so a
 *   recording can only carry a placeholder and fill it in at playback
 *
 *   it waits — at each of the viewer's turns the replay holds until they act (or
 *   until their clock runs out, which is worth watching too), so the action bar,
 *   the slider and the timer ring are all genuinely exercised
 */
export interface FixtureControls {
  play(): void;
  pause(): void;
  /** Runs the next frame immediately, whatever it was waiting for. */
  step(): void;
  restart(): void;
  setSpeed(multiplier: number): void;
  subscribe(listener: (status: FixtureStatus) => void): () => void;
  status(): FixtureStatus;
}

export interface FixtureStatus {
  readonly playing: boolean;
  readonly speed: number;
  readonly frame: number;
  readonly total: number;
  /** What the recording does next when it is the viewer's turn, or null. */
  readonly waitingLabel: string | null;
  readonly finished: boolean;
}

export interface FixtureTransport extends Transport {
  readonly controls: FixtureControls;
}

const SPEEDS = [0.5, 1, 2, 4] as const;
export const FIXTURE_SPEEDS = SPEEDS;

/**
 * The controls of whichever fixture transport is currently open.
 *
 * There is at most one table on screen, so this is a module-level value rather
 * than something threaded through props — and exposing it as an external store
 * lets the replay bar read it with `useSyncExternalStore`, without a render
 * that sets state in an effect.
 */
let openControls: FixtureControls | null = null;
const controlWatchers = new Set<() => void>();

export function subscribeFixtureControls(listener: () => void): () => void {
  controlWatchers.add(listener);
  return () => {
    controlWatchers.delete(listener);
  };
}

export function getFixtureControls(): FixtureControls | null {
  return openControls;
}

function setOpenControls(controls: FixtureControls | null): void {
  openControls = controls;
  for (const watcher of controlWatchers) watcher();
}

export function createFixtureTransport(): FixtureTransport {
  const listeners = new Set<TransportListener>();
  const statusListeners = new Set<(status: FixtureStatus) => void>();

  let index = 0;
  let playing = true;
  let speed = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: ScriptFrame['waitFor'] | null = null;
  let closed = false;

  const publish = (frame: TransportFrame): void => {
    for (const listener of listeners) listener(frame);
  };

  const status = (): FixtureStatus => ({
    playing,
    speed,
    frame: index,
    total: SCRIPT.length,
    waitingLabel: waiting?.label ?? null,
    finished: index >= SCRIPT.length,
  });

  const publishStatus = (): void => {
    const snapshot = status();
    for (const listener of statusListeners) listener(snapshot);
  };

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  /** Emit the frame at `index`, then queue the one after it. */
  const run = (): void => {
    const frame = SCRIPT[index];
    if (!frame || closed) return;

    index += 1;
    waiting = null;
    publish({ kind: 'event', event: frame.event, payload: stamp(frame.payload) });
    publishStatus();
    schedule();
  };

  const schedule = (): void => {
    clearTimer();
    if (closed || !playing) return;

    const next = SCRIPT[index];
    if (!next) {
      publishStatus();
      return;
    }

    if (next.waitFor) {
      // The viewer is on the clock. Nothing moves until they act — or until the
      // clock runs out, which the recording answers the same way the server
      // would: with the action that was going to happen anyway.
      waiting = next.waitFor;
      publishStatus();
      timer = setTimeout(run, FIXTURE_CONFIG.actionTimeoutSec * 1000);
      return;
    }

    timer = setTimeout(run, Math.max(0, next.delayMs / speed));
  };

  const controls: FixtureControls = {
    play() {
      playing = true;
      schedule();
      publishStatus();
    },
    pause() {
      playing = false;
      clearTimer();
      publishStatus();
    },
    step() {
      clearTimer();
      run();
    },
    restart() {
      clearTimer();
      index = 0;
      waiting = null;
      playing = true;
      publish({ kind: 'open', reconnected: false });
      schedule();
      publishStatus();
    },
    setSpeed(multiplier) {
      speed = SPEEDS.includes(multiplier as (typeof SPEEDS)[number]) ? multiplier : 1;
      schedule();
      publishStatus();
    },
    subscribe(listener) {
      statusListeners.add(listener);
      listener(status());
      return () => {
        statusListeners.delete(listener);
      };
    },
    status,
  };

  setOpenControls(controls);

  const transport: FixtureTransport = {
    kind: 'fixture',
    controls,

    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Give React a tick to mount before the first frame lands, so the open
        // and the first sync are two renders rather than one.
        setTimeout(() => {
          publish({ kind: 'open', reconnected: false });
          schedule();
        }, 0);
      }
      return () => {
        listeners.delete(listener);
      };
    },

    emit<T>(event: string, payload?: unknown): Promise<Ack<T>> {
      const answer = acknowledge<T>(event, payload);

      // Whatever the viewer chose, the recording plays its own line — it has no
      // engine behind it to work out the consequences of a different one. The
      // fixture bar says so before they click.
      if (waiting?.clientEvent === event) {
        clearTimer();
        setTimeout(run, 120);
      }

      return Promise.resolve(answer);
    },

    close() {
      closed = true;
      clearTimer();
      listeners.clear();
      statusListeners.clear();
      if (openControls === controls) setOpenControls(null);
    },
  };

  return transport;
}

function acknowledge<T>(event: string, payload: unknown): Ack<T> {
  switch (event) {
    case CLIENT_EVENTS.tableCreate:
    case CLIENT_EVENTS.tableJoin:
      return ok<T>({ code: FIXTURE_TABLE_CODE, config: FIXTURE_CONFIG });

    case CLIENT_EVENTS.tableSit:
      return ok<T>({ seatIndex: (payload as { seatIndex?: number }).seatIndex ?? 0 });

    case CLIENT_EVENTS.playerAction:
      return ok<T>({ actionSeq: (payload as { actionSeq?: number }).actionSeq ?? 0 });

    default:
      return ok<T>({});
  }
}

function ok<T>(data: unknown): Ack<T> {
  return { ok: true, data: data as T };
}

/**
 * Replace the recording's deadline placeholders with real ones.
 *
 * Only `-1` in a `deadlineTs` or `actionDeadlineTs` field is touched; every
 * other number in the frame is the recording's own.
 */
function stamp(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(stamp);
  if (typeof payload !== 'object' || payload === null) return payload;

  const source = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    const isDeadline = key === 'deadlineTs' || key === 'actionDeadlineTs';
    if (isDeadline && value === DEADLINE) {
      result[key] = Date.now() + FIXTURE_CONFIG.actionTimeoutSec * 1000;
    } else if (key === 'at' && value === 0) {
      result[key] = Date.now();
    } else {
      result[key] = stamp(value);
    }
  }

  return result;
}
