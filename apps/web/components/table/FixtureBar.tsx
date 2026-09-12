'use client';

import { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import {
  FIXTURE_SPEEDS,
  type FixtureControls,
  type FixtureStatus,
} from '../../lib/net/fixture-transport';
import { cx } from '../../lib/cx';

/**
 * Transport controls for the recorded hand.
 *
 * This bar exists only in fixture mode. It is the honest label on the whole
 * thing: the recording plays one line, and when it is the viewer's turn it says
 * which one, so nobody clicks Fold and is surprised to see a call. Everything
 * else about the action bar — the slider, the snapping, the keyboard, the
 * disable-on-click — is the real thing.
 */
export function FixtureBar({ controls }: { controls: FixtureControls }) {
  const status = useFixtureStatus(controls);

  return (
    <section
      aria-label="Fixture replay controls"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-amber-300/30 bg-amber-300/5 px-3 py-2"
    >
      <span className="rounded bg-amber-300/15 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide text-amber-200 uppercase">
        Replay
      </span>

      <p className="min-w-0 flex-1 text-xs text-neutral-400">
        {status.finished ? (
          'The recorded hand is over.'
        ) : status.waitingLabel === null ? (
          <>
            Frame <span className="tabular">{status.frame}</span> of{' '}
            <span className="tabular">{status.total}</span>
          </>
        ) : (
          <>
            Your turn. The recorded line is{' '}
            <span className="font-medium text-amber-200">{status.waitingLabel}</span> — any action
            resumes it.
          </>
        )}
      </p>

      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          className="min-h-9 px-3 text-xs"
          onClick={() => {
            if (status.playing) controls.pause();
            else controls.play();
          }}
        >
          {status.playing ? 'Pause' : 'Play'}
        </Button>

        <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={() => controls.step()}>
          Step
        </Button>

        <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={() => controls.restart()}>
          Restart
        </Button>

        <span className="flex overflow-hidden rounded-lg ring-1 ring-white/15">
          {FIXTURE_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              aria-pressed={status.speed === speed}
              onClick={() => {
                controls.setSpeed(speed);
              }}
              className={cx(
                'tabular min-h-9 px-2 text-xs',
                status.speed === speed
                  ? 'bg-accent text-felt-950 font-semibold'
                  : 'text-neutral-300 hover:bg-white/10',
              )}
            >
              {speed}&times;
            </button>
          ))}
        </span>
      </div>
    </section>
  );
}

function useFixtureStatus(controls: FixtureControls): FixtureStatus {
  const [status, setStatus] = useState<FixtureStatus>(() => controls.status());

  useEffect(() => {
    return controls.subscribe(setStatus);
  }, [controls]);

  return status;
}
