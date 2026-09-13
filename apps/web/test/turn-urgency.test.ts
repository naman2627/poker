/**
 * The two bits of urgency: the colour of the ring, and the text in the tab.
 *
 * Both are pure decisions pulled out of their components so the thresholds can
 * be asserted directly — the alternative is rendering a clock and waiting,
 * which tests the interval rather than the rule.
 */
import { describe, expect, it } from 'vitest';
import { AMBER_MS, RED_MS, urgencyOf } from '../components/table/TimerRing';
import { FLASH_MS, TURN_TITLE, shouldFlashTitle, titleForTick } from '../lib/turn-title';

describe('the timer ring', () => {
  it('is calm with plenty of time', () => {
    expect(urgencyOf(30_000)).toBe('calm');
    expect(urgencyOf(15_000)).toBe('calm');
  });

  it('turns amber at ten seconds', () => {
    expect(urgencyOf(AMBER_MS + 1)).toBe('calm');
    expect(urgencyOf(AMBER_MS)).toBe('amber');
    expect(urgencyOf(9_000)).toBe('amber');
  });

  it('turns red at five seconds', () => {
    expect(urgencyOf(RED_MS + 1)).toBe('amber');
    expect(urgencyOf(RED_MS)).toBe('red');
    expect(urgencyOf(1_200)).toBe('red');
  });

  it('stays red once the clock is out', () => {
    expect(urgencyOf(0)).toBe('red');
    // A deadline in the past is clamped to zero upstream; be safe anyway.
    expect(urgencyOf(-500)).toBe('red');
  });

  /**
   * The thresholds are absolute because they are about the player, not the
   * table: ten seconds is ten seconds whether the timer started at fifteen or
   * at sixty.
   */
  it('uses the same wall-clock thresholds at every timer length', () => {
    expect(AMBER_MS).toBe(10_000);
    expect(RED_MS).toBe(5_000);
    expect(RED_MS).toBeLessThan(AMBER_MS);
  });
});

describe('the tab title', () => {
  it('flashes only when it is your turn and you are looking elsewhere', () => {
    expect(shouldFlashTitle({ myTurn: true, hidden: true })).toBe(true);
  });

  it('stays quiet while the tab is being looked at', () => {
    expect(shouldFlashTitle({ myTurn: true, hidden: false })).toBe(false);
  });

  it('stays quiet when the turn is not yours', () => {
    expect(shouldFlashTitle({ myTurn: false, hidden: true })).toBe(false);
    expect(shouldFlashTitle({ myTurn: false, hidden: false })).toBe(false);
  });

  it('alternates between the alert and whatever the page was called', () => {
    expect(titleForTick('Poker', 0)).toBe(TURN_TITLE);
    expect(titleForTick('Poker', 1)).toBe('Poker');
    expect(titleForTick('Poker', 2)).toBe(TURN_TITLE);
    expect(titleForTick('Poker', 3)).toBe('Poker');
  });

  it('says something a person would notice in a row of tabs', () => {
    expect(TURN_TITLE).toMatch(/your turn/i);
  });

  it('alternates slowly enough to read', () => {
    expect(FLASH_MS).toBeGreaterThanOrEqual(500);
    expect(FLASH_MS).toBeLessThanOrEqual(2_000);
  });
});
