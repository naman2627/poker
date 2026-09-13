/**
 * The rules a preference obeys.
 *
 * Pure functions only — no storage, no React. What is worth pinning down here
 * is the parsing: a preferences blob is the one thing in the app that survives
 * a deploy, so it is also the one most likely to be from an older version of
 * the type, hand-edited, or truncated.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHRASES,
  DEFAULT_PREFS,
  MAX_PHRASES,
  MAX_PHRASE_LENGTH,
  clampVolume,
  normalisePhrases,
  parsePrefs,
} from '../lib/prefs/prefs';

describe('defaults', () => {
  it('starts silent, on a paper deck', () => {
    expect(DEFAULT_PREFS.soundEnabled).toBe(false);
    expect(DEFAULT_PREFS.turnChime).toBe(false);
    expect(DEFAULT_PREFS.deck).toBe('classic');
  });

  it('starts at a volume somebody can hear but nobody jumps at', () => {
    expect(DEFAULT_PREFS.volume).toBeGreaterThan(0);
    expect(DEFAULT_PREFS.volume).toBeLessThanOrEqual(1);
  });

  it('ships phrases that fit', () => {
    expect(DEFAULT_PHRASES.length).toBeLessThanOrEqual(MAX_PHRASES);
    for (const phrase of DEFAULT_PHRASES) {
      expect(phrase.length).toBeLessThanOrEqual(MAX_PHRASE_LENGTH);
    }
  });
});

describe('clampVolume', () => {
  it('keeps a fraction as it is', () => {
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(0.4)).toBe(0.4);
    expect(clampVolume(1)).toBe(1);
  });

  it('pulls anything outside the range back in', () => {
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(42)).toBe(1);
  });

  it('falls back rather than trusting nonsense', () => {
    expect(clampVolume('loud')).toBe(DEFAULT_PREFS.volume);
    expect(clampVolume(NaN)).toBe(DEFAULT_PREFS.volume);
    expect(clampVolume(Infinity)).toBe(DEFAULT_PREFS.volume);
    expect(clampVolume(null)).toBe(DEFAULT_PREFS.volume);
  });
});

describe('normalisePhrases', () => {
  it('takes one phrase per line', () => {
    expect(normalisePhrases('Nice hand\nGood fold')).toEqual(['Nice hand', 'Good fold']);
  });

  it('drops blanks and tidies whitespace', () => {
    expect(normalisePhrases('  Nice   hand \n\n\n  Wow  \n')).toEqual(['Nice hand', 'Wow']);
  });

  it('drops duplicates, whatever the casing', () => {
    expect(normalisePhrases('Wow\nwow\nWOW\nNice')).toEqual(['Wow', 'Nice']);
  });

  it('cuts a long phrase rather than refusing it', () => {
    const long = 'a'.repeat(MAX_PHRASE_LENGTH + 30);
    const [only] = normalisePhrases(long);
    expect(only).toHaveLength(MAX_PHRASE_LENGTH);
  });

  /**
   * A settings box that rejects a paste and makes you count lines is worse than
   * one that keeps the first eight and shows you what it kept.
   */
  it('keeps the first eight of a long paste', () => {
    const pasted = Array.from({ length: 20 }, (_, i) => `Phrase ${String(i)}`).join('\n');
    const kept = normalisePhrases(pasted);

    expect(kept).toHaveLength(MAX_PHRASES);
    expect(kept[0]).toBe('Phrase 0');
    expect(kept[MAX_PHRASES - 1]).toBe(`Phrase ${String(MAX_PHRASES - 1)}`);
  });

  it('accepts an array as readily as a textarea', () => {
    expect(normalisePhrases(['One', '', '  Two  '])).toEqual(['One', 'Two']);
  });

  it('is happy to end up with nothing', () => {
    expect(normalisePhrases('   \n \n')).toEqual([]);
  });
});

describe('parsePrefs', () => {
  it('reads a whole, valid blob back', () => {
    const stored = {
      deck: 'four-colour',
      soundEnabled: true,
      turnChime: true,
      volume: 0.25,
      quickPhrases: ['Nice hand'],
    };

    expect(parsePrefs(stored)).toEqual({
      deck: 'four-colour',
      soundEnabled: true,
      turnChime: true,
      volume: 0.25,
      quickPhrases: ['Nice hand'],
    });
  });

  it('falls back to the defaults for anything that is not an object', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('nope')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
  });

  /**
   * Each field falls back on its own, so a player who gains a new preference in
   * a deploy does not lose the ones they had already set.
   */
  it('keeps the fields it recognises and defaults the rest', () => {
    const fromAnOlderVersion = { soundEnabled: true, turnChime: true };
    const parsed = parsePrefs(fromAnOlderVersion);

    expect(parsed.soundEnabled).toBe(true);
    expect(parsed.turnChime).toBe(true);
    expect(parsed.deck).toBe(DEFAULT_PREFS.deck);
    expect(parsed.volume).toBe(DEFAULT_PREFS.volume);
    expect(parsed.quickPhrases).toEqual(DEFAULT_PHRASES);
  });

  it('refuses a deck style it has never heard of', () => {
    expect(parsePrefs({ deck: 'holographic' }).deck).toBe('classic');
  });

  it('treats a truthy-but-not-true switch as off', () => {
    // Only `true` is on. "true", 1 and {} are somebody else's JSON.
    expect(parsePrefs({ soundEnabled: 'true' }).soundEnabled).toBe(false);
    expect(parsePrefs({ turnChime: 1 }).turnChime).toBe(false);
  });

  it('cleans up phrases that were stored badly', () => {
    const parsed = parsePrefs({ quickPhrases: ['  Wow ', 'wow', '', 42, 'Nice'] });
    expect(parsed.quickPhrases).toEqual(['Wow', 'Nice']);
  });

  it('clamps a volume that was out of range in storage', () => {
    expect(parsePrefs({ volume: 9 }).volume).toBe(1);
    expect(parsePrefs({ volume: -1 }).volume).toBe(0);
  });
});
