'use client';

import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx';

/**
 * The clock, drawn as a draining ring.
 *
 * `deadlineTs` is absolute epoch milliseconds because the server said so — a
 * player whose machine is a minute fast gets a ring that is wrong by a minute
 * and exactly the same amount of real time to act, which is the right trade.
 *
 * The ring animates on an interval rather than a CSS transition so the number
 * inside it and the arc around it can never disagree.
 */
const TICK_MS = 100;

/**
 * How close to the buzzer the ring starts worrying.
 *
 * Absolute seconds, not a fraction of the clock. A quarter of a thirty-second
 * timer is seven and a half seconds and a quarter of a fifteen-second timer is
 * under four — the same colour would mean two different amounts of time to act,
 * which is exactly the thing a player is reading it for.
 */
export const AMBER_MS = 10_000;
export const RED_MS = 5_000;

export type Urgency = 'calm' | 'amber' | 'red';

/** Pure, so the thresholds can be asserted without rendering a clock. */
export function urgencyOf(remainingMs: number): Urgency {
  if (remainingMs <= RED_MS) return 'red';
  if (remainingMs <= AMBER_MS) return 'amber';
  return 'calm';
}

const STROKE: Readonly<Record<Urgency, string>> = {
  calm: 'var(--color-accent)',
  amber: 'var(--color-warn)',
  red: 'var(--color-danger)',
};

export interface TimerRingProps {
  readonly deadlineTs: number;
  readonly totalSec: number;
  readonly size?: number;
  readonly className?: string;
}

export function TimerRing({ deadlineTs, totalSec, size = 56, className }: TimerRingProps) {
  const remaining = useCountdown(deadlineTs);
  const fraction = Math.max(0, Math.min(1, remaining / (totalSec * 1000)));
  const seconds = Math.ceil(remaining / 1000);

  const radius = size / 2 - 3;
  const circumference = 2 * Math.PI * radius;
  const urgency = urgencyOf(remaining);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      className={cx('pointer-events-none', className)}
      role="timer"
      aria-label={`${String(seconds)} seconds to act`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={3}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={STROKE[urgency]}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        // Start the arc at twelve o'clock and drain clockwise.
        transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
        // Only the last five seconds pulse. Amber is a warning; red is a hurry.
        className={urgency === 'red' ? 'animate-pulse-ring' : undefined}
      />
    </svg>
  );
}

/**
 * Milliseconds left, recomputed on a timer. Never below zero.
 *
 * The state here is the clock, not the answer: the interval moves `now` forward
 * and the remaining time is derived from it on render. Keeping the derived
 * number out of state is what lets a changed deadline take effect on the next
 * render rather than the next tick.
 */
export function useCountdown(deadlineTs: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadlineTs === null) return;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [deadlineTs]);

  return deadlineTs === null ? 0 : Math.max(0, deadlineTs - now);
}
