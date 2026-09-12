import { describe, expect, it } from 'vitest';
import type { LegalActions } from '@poker/shared';
import { potFractionRaise, raiseBounds, snapRaise } from '../lib/raise';

const legal = (over: Partial<LegalActions> = {}): LegalActions => ({
  canFold: true,
  canCheck: false,
  canCall: true,
  callAmount: 60,
  canBet: false,
  canRaise: true,
  minRaiseTo: 120,
  maxRaiseTo: 970,
  ...over,
});

describe('snapRaise', () => {
  const bounds = raiseBounds(legal(), 10);

  it('cannot go below the minimum the server allows', () => {
    expect(snapRaise(5, bounds)).toBe(120);
    expect(snapRaise(-100, bounds)).toBe(120);
  });

  it('cannot go above the maximum the server allows', () => {
    expect(snapRaise(99_999, bounds)).toBe(970);
  });

  it('snaps to the big-blind grid, starting at the minimum', () => {
    expect(snapRaise(121, bounds)).toBe(120);
    expect(snapRaise(126, bounds)).toBe(130);
    expect(snapRaise(134, bounds)).toBe(130);
  });

  it('always reaches all in — the top of the range is never off-grid', () => {
    // 970 is not 120 + a whole number of tens, so the grid alone would miss it.
    expect(snapRaise(968, bounds)).toBe(970);
    expect(snapRaise(970, bounds)).toBe(970);
  });

  it('collapses to all in when the range has nowhere to move', () => {
    const pinned = raiseBounds(legal({ minRaiseTo: 400, maxRaiseTo: 400 }), 10);
    expect(snapRaise(120, pinned)).toBe(400);
  });

  it('never returns a fraction of a chip', () => {
    expect(Number.isInteger(snapRaise(137.6, bounds))).toBe(true);
  });
});

describe('potFractionRaise', () => {
  const bounds = raiseBounds(legal(), 10);

  it('sizes a pot raise off the pot the call would make', () => {
    // Pot 100, call 60: calling makes it 160, and a pot-sized raise adds that on
    // top of the call — 60 + 60 + 160 = 280.
    expect(potFractionRaise(1, { potTotal: 100, callAmount: 60, currentBet: 60 }, bounds)).toBe(
      280,
    );
  });

  it('clamps a preset that lands under the minimum raise', () => {
    const tiny = potFractionRaise(0.5, { potTotal: 4, callAmount: 0, currentBet: 0 }, bounds);
    expect(tiny).toBe(bounds.min);
  });

  it('clamps a preset that lands over the stack', () => {
    const huge = potFractionRaise(1, { potTotal: 50_000, callAmount: 60, currentBet: 60 }, bounds);
    expect(huge).toBe(bounds.max);
  });
});
