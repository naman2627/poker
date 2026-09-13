/**
 * Reactions and muting, on the client's side.
 *
 * The cooldown is not tested here because it is not the client's — it lives in
 * `TableRuntime.emote` and is covered by `table-emote.test.ts` on the server.
 * What this file pins down is the vocabulary and the mute list, both of which
 * are pure.
 */
import { describe, expect, it } from 'vitest';
import { EMOTES, EMOTE_COOLDOWN_MS, EmoteSchema } from '@poker/shared';
import { EMOTE_LIFETIME_MS, EMOTE_LOOKS, emoteLook, everyEmote } from '../lib/emotes';
import { DEFAULT_PREFS, parsePrefs, toggleMuted } from '../lib/prefs/prefs';

describe('the six reactions', () => {
  it('offers exactly the six the server accepts', () => {
    expect(EMOTE_LOOKS).toHaveLength(6);
    expect(EMOTE_LOOKS.map((look) => look.id).sort()).toEqual([...EMOTES].sort());
    expect(everyEmote()).toEqual(EMOTES);
  });

  it('gives each one a glyph and a spoken name', () => {
    for (const look of EMOTE_LOOKS) {
      expect(look.glyph.length).toBeGreaterThan(0);
      expect(look.label.length).toBeGreaterThan(2);
    }
  });

  it('has a distinct look for each', () => {
    expect(new Set(EMOTE_LOOKS.map((look) => look.glyph)).size).toBe(6);
    expect(new Set(EMOTE_LOOKS.map((look) => look.label)).size).toBe(6);
  });

  it('looks up by id', () => {
    expect(emoteLook('clap').glyph).toBe('👏');
    expect(emoteLook('salt').label).toBe('Salty');
  });

  it('accepts only the six on the wire', () => {
    for (const id of EMOTES) expect(EmoteSchema.safeParse(id).success).toBe(true);
    expect(EmoteSchema.safeParse('rude').success).toBe(false);
    expect(EmoteSchema.safeParse('').success).toBe(false);
  });

  /**
   * A reaction has to be gone before the same seat can send another, or two
   * would sit on top of each other over one chair.
   */
  it('fades before the cooldown lets the same seat react again', () => {
    expect(EMOTE_LIFETIME_MS).toBeLessThan(EMOTE_COOLDOWN_MS);
  });
});

describe('muting', () => {
  it('adds somebody who is not muted', () => {
    expect(toggleMuted([], 'ada')).toEqual(['ada']);
    expect(toggleMuted(['bo'], 'ada')).toEqual(['bo', 'ada']);
  });

  it('removes somebody who is', () => {
    expect(toggleMuted(['ada'], 'ada')).toEqual([]);
    expect(toggleMuted(['bo', 'ada', 'cy'], 'ada')).toEqual(['bo', 'cy']);
  });

  it('never doubles anybody up', () => {
    let muted = toggleMuted([], 'ada');
    muted = toggleMuted(muted, 'ada');
    muted = toggleMuted(muted, 'ada');
    expect(muted).toEqual(['ada']);
  });

  it('does not mutate the list it was given', () => {
    const before: readonly string[] = ['ada'];
    toggleMuted(before, 'bo');
    expect(before).toEqual(['ada']);
  });

  it('starts with nobody muted', () => {
    expect(DEFAULT_PREFS.mutedUserIds).toEqual([]);
  });

  it('survives a reload, and drops anything that is not an id', () => {
    const parsed = parsePrefs({ mutedUserIds: ['ada', 'bo', 'ada', 7, null] });
    expect(parsed.mutedUserIds).toEqual(['ada', 'bo']);
  });

  it('falls back to nobody when the stored value is nonsense', () => {
    expect(parsePrefs({ mutedUserIds: 'ada' }).mutedUserIds).toEqual([]);
    expect(parsePrefs({}).mutedUserIds).toEqual([]);
  });
});
