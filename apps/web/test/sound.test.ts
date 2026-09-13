/**
 * What makes a noise, and what is allowed to.
 *
 * All of it pure: the specs are data, the mapping is a function, and the two
 * switches are a predicate. No AudioContext is constructed anywhere in here,
 * which is the point of keeping `sounds.ts` free of Web Audio.
 */
import { describe, expect, it } from 'vitest';
import type { TableEvent } from '@poker/shared';
import {
  MASTER_GAIN,
  SILENT,
  SOUNDS,
  durationOf,
  shouldPlay,
  soundForEvent,
  soundsForPatch,
  type SoundName,
} from '../lib/sound/sounds';

const ALL: SoundName[] = ['deal', 'chip', 'check', 'fold', 'turn', 'win'];

describe('the six sounds', () => {
  it('has a spec for each one', () => {
    for (const name of ALL) expect(SOUNDS[name]).toBeDefined();
  });

  it('is made of tones and noise rather than files', () => {
    for (const name of ALL) {
      const spec = SOUNDS[name];
      expect(spec.voices.length + spec.noise.length).toBeGreaterThan(0);
    }
  });

  it('keeps every sound short enough not to overlap the next action', () => {
    for (const name of ALL) {
      expect(durationOf(SOUNDS[name])).toBeGreaterThan(0);
      expect(durationOf(SOUNDS[name])).toBeLessThanOrEqual(0.6);
    }
  });

  it('stays quiet — nothing peaks near full scale', () => {
    expect(MASTER_GAIN).toBeLessThan(0.5);
    for (const name of ALL) {
      for (const voice of SOUNDS[name].voices) expect(voice.gain).toBeLessThanOrEqual(0.5);
      for (const burst of SOUNDS[name].noise) expect(burst.gain).toBeLessThanOrEqual(0.5);
    }
  });

  it('never asks for a frequency an oscillator cannot ramp to', () => {
    // Exponential ramps cannot reach zero; a spec with a zero target would be a
    // silent throw at play time rather than a caught one.
    for (const name of ALL) {
      for (const voice of SOUNDS[name].voices) {
        expect(voice.from).toBeGreaterThan(0);
        if (voice.to !== undefined) expect(voice.to).toBeGreaterThan(0);
      }
    }
  });
});

describe('the two switches', () => {
  it('starts everything off', () => {
    expect(SILENT.enabled).toBe(false);
    expect(SILENT.turnChime).toBe(false);
    for (const name of ALL) expect(shouldPlay(name, SILENT)).toBe(false);
  });

  /**
   * THE RULE. The chime is not a child of the master switch — it is the sound
   * people want *instead of* the rest, so it has to be reachable on its own.
   */
  it('plays the chime with the master switch off', () => {
    const prefs = { enabled: false, turnChime: true };

    expect(shouldPlay('turn', prefs)).toBe(true);
    expect(shouldPlay('chip', prefs)).toBe(false);
    expect(shouldPlay('deal', prefs)).toBe(false);
    expect(shouldPlay('win', prefs)).toBe(false);
  });

  it('plays the table with the chime off', () => {
    const prefs = { enabled: true, turnChime: false };

    expect(shouldPlay('turn', prefs)).toBe(false);
    expect(shouldPlay('chip', prefs)).toBe(true);
    expect(shouldPlay('check', prefs)).toBe(true);
  });

  it('plays everything with both on', () => {
    const prefs = { enabled: true, turnChime: true };
    for (const name of ALL) expect(shouldPlay(name, prefs)).toBe(true);
  });
});

describe('which event makes which sound', () => {
  const event = (over: Record<string, unknown>): TableEvent => over as unknown as TableEvent;

  it('deals on hole cards and on a board', () => {
    expect(soundForEvent(event({ type: 'HOLE_CARDS_DEALT' }), 0)).toBe('deal');
    expect(soundForEvent(event({ type: 'BOARD_DEALT' }), 0)).toBe('deal');
  });

  it('clinks on anything that moves chips', () => {
    expect(soundForEvent(event({ type: 'BLIND_POSTED' }), 0)).toBe('chip');
    for (const action of ['CALL', 'BET', 'RAISE', 'ALL_IN']) {
      expect(soundForEvent(event({ type: 'PLAYER_ACTED', action }), 0)).toBe('chip');
    }
  });

  it('knocks on a check and sighs on a fold', () => {
    expect(soundForEvent(event({ type: 'PLAYER_ACTED', action: 'CHECK' }), 0)).toBe('check');
    expect(soundForEvent(event({ type: 'PLAYER_ACTED', action: 'FOLD' }), 0)).toBe('fold');
  });

  it('treats a timeout as whatever the server actually applied', () => {
    expect(soundForEvent(event({ type: 'ACTION_TIMED_OUT', appliedAction: 'FOLD' }), 0)).toBe(
      'fold',
    );
    expect(soundForEvent(event({ type: 'ACTION_TIMED_OUT', appliedAction: 'CHECK' }), 0)).toBe(
      'check',
    );
  });

  /**
   * A win chime for somebody else's pot would be the table congratulating you
   * on losing. It is the first sound anybody would switch off.
   */
  it('only celebrates the viewer winning', () => {
    const awarded = event({ type: 'POT_AWARDED', seatIndex: 2 });

    expect(soundForEvent(awarded, 2)).toBe('win');
    expect(soundForEvent(awarded, 5)).toBeNull();
    expect(soundForEvent(awarded, null)).toBeNull();
  });

  it('says nothing about events with no sound of their own', () => {
    expect(soundForEvent(event({ type: 'ACTION_ON', seatIndex: 1 }), 1)).toBeNull();
    expect(soundForEvent(event({ type: 'PHASE_CHANGED', to: 'flop' }), 1)).toBeNull();
    expect(soundForEvent(event({ type: 'HAND_ENDED' }), 1)).toBeNull();
  });
});

describe('a whole patch', () => {
  const event = (over: Record<string, unknown>): TableEvent => over as unknown as TableEvent;

  it('plays each kind of sound at most once, however many events', () => {
    // A street: three board cards and two seats checking.
    const sounds = soundsForPatch(
      [
        event({ type: 'BOARD_DEALT' }),
        event({ type: 'BOARD_DEALT' }),
        event({ type: 'BOARD_DEALT' }),
        event({ type: 'PLAYER_ACTED', action: 'CHECK' }),
        event({ type: 'PLAYER_ACTED', action: 'CHECK' }),
      ],
      0,
    );

    expect(sounds).toEqual(['deal', 'check']);
  });

  it('keeps the order the events arrived in', () => {
    const sounds = soundsForPatch(
      [
        event({ type: 'PLAYER_ACTED', action: 'FOLD' }),
        event({ type: 'PLAYER_ACTED', action: 'RAISE' }),
        event({ type: 'BOARD_DEALT' }),
      ],
      0,
    );

    expect(sounds).toEqual(['fold', 'chip', 'deal']);
  });

  it('is silent for a patch with nothing audible in it', () => {
    expect(soundsForPatch([event({ type: 'ACTION_ON', seatIndex: 1 })], 0)).toEqual([]);
    expect(soundsForPatch([], 0)).toEqual([]);
  });

  it('never emits the chime, which comes from the prompt instead', () => {
    const sounds = soundsForPatch(
      [event({ type: 'ACTION_ON', seatIndex: 0 }), event({ type: 'PLAYER_ACTED', action: 'BET' })],
      0,
    );

    expect(sounds).not.toContain('turn');
  });
});
