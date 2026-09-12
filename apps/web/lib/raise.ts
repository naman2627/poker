import type { LegalActions } from '@poker/shared';

/**
 * The raise slider, and nothing more.
 *
 * These functions decide where a *control* sits, never what is legal: the range
 * comes from the server's `legalActions`, and the server checks the number again
 * when the action arrives (CLAUDE.md §4). A preset that lands outside the range
 * is clamped back into it, so the slider can never propose an illegal amount —
 * but the clamping here is a courtesy to the player, not an authority.
 */
export interface RaiseBounds {
  readonly min: number;
  readonly max: number;
  /** The increment the slider snaps to, normally one big blind. */
  readonly step: number;
}

export function raiseBounds(legal: LegalActions, bigBlind: number): RaiseBounds {
  return {
    min: legal.minRaiseTo,
    max: legal.maxRaiseTo,
    step: Math.max(1, bigBlind),
  };
}

/**
 * Snap a slider position to a legal total.
 *
 * The grid starts at the minimum legal raise, so the first stop is always a
 * number the server will accept. The maximum is always reachable — going all in
 * must never be off-grid — and anything within half a step of it snaps there.
 */
export function snapRaise(value: number, bounds: RaiseBounds): number {
  const { min, max, step } = bounds;
  if (max <= min) return max;

  const clamped = Math.min(max, Math.max(min, Math.round(value)));
  if (clamped >= max - step / 2) return max;

  const steps = Math.round((clamped - min) / step);
  return Math.min(max, min + steps * step);
}

/**
 * The pot-fraction buttons.
 *
 * A "pot-sized raise" is the standard shorthand: call first, then bet the pot
 * that call has just made. `potTotal` and `callAmount` both come from the
 * server, and the result is snapped back into the legal range before it is
 * offered — the button is a shortcut to a slider position, not a rule.
 */
export function potFractionRaise(
  fraction: number,
  input: { potTotal: number; callAmount: number; currentBet: number },
  bounds: RaiseBounds,
): number {
  const potAfterCall = input.potTotal + input.callAmount;
  const target = input.currentBet + input.callAmount + fraction * potAfterCall;
  return snapRaise(target, bounds);
}

export const POT_PRESETS = [
  { label: '½ pot', fraction: 0.5 },
  { label: '¾ pot', fraction: 0.75 },
  { label: 'Pot', fraction: 1 },
] as const;
