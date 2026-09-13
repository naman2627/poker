/**
 * What a player has decided about their own table.
 *
 * Pure data and pure functions: no storage, no React, no Web Audio. The store
 * that persists this is `store.ts`; everything that is a *rule* about a
 * preference — what a legal volume is, how many phrases are allowed, what
 * happens when somebody pastes nine of them — lives here where it can be
 * tested by calling a function.
 *
 * None of this reaches the server. A preference is about how the table looks
 * and sounds to one person; nothing here can change what a hand does, and
 * nothing here is trusted by anybody else (CLAUDE.md §4 is about *actions*, and
 * these are not actions).
 */

export type DeckStyle = 'classic' | 'four-colour';

export interface Prefs {
  /** Two-colour like a real deck, or a colour per suit. */
  readonly deck: DeckStyle;
  /** The five table sounds. Off by default. */
  readonly soundEnabled: boolean;
  /** The your-turn chime. Its own switch — see `sounds.ts`. Off by default. */
  readonly turnChime: boolean;
  /** 0..1, scaling the master gain. Not a switch — the switches are above. */
  readonly volume: number;
  /** One-tap things to say. Empty means the player cleared them. */
  readonly quickPhrases: readonly string[];
  /**
   * People this viewer would rather not hear from.
   *
   * One list for chat and reactions together, because muting somebody who is
   * being tiresome in one and not the other is not a thing anybody wants. It
   * lives on the device and is never sent anywhere: the server has no opinion
   * about who you want to hear from, and the person muted is never told.
   */
  readonly mutedUserIds: readonly string[];
}

/**
 * How many phrases fit under the chat box without it becoming a menu.
 *
 * Eight is two rows of four on a phone. A ninth would push the chat log up far
 * enough to matter, which is the wrong trade for a shortcut.
 */
export const MAX_PHRASES = 8;

/** Long enough for "nice hand, I had nothing", short enough to stay a chip. */
export const MAX_PHRASE_LENGTH = 24;

/**
 * What a new player starts with.
 *
 * Deliberately mild. These are the things people already say at a table, and a
 * default set that came out swinging would be the first thing anybody deleted.
 */
export const DEFAULT_PHRASES: readonly string[] = [
  'Nice hand',
  'Good fold',
  'Wow.',
  'One sec',
  'All yours',
  'Rigged',
];

export const DEFAULT_PREFS: Prefs = {
  deck: 'classic',
  soundEnabled: false,
  turnChime: false,
  volume: 0.7,
  quickPhrases: DEFAULT_PHRASES,
  mutedUserIds: [],
};

/** Volume is a fraction. Anything else is somebody's bad JSON. */
export function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PREFS.volume;
  return Math.min(1, Math.max(0, value));
}

/**
 * Turn whatever is in the textarea into phrases.
 *
 * One per line, trimmed, blanks dropped, duplicates dropped, each cut to length
 * and the whole list cut to `MAX_PHRASES`. Silently, on purpose: a settings box
 * that rejects a paste and makes you count lines is worse than one that takes
 * the first eight and shows you what it kept.
 */
export function normalisePhrases(input: string | readonly string[]): string[] {
  const lines = typeof input === 'string' ? input.split('\n') : [...input];
  const kept: string[] = [];

  for (const line of lines) {
    const phrase = line.trim().replace(/\s+/g, ' ').slice(0, MAX_PHRASE_LENGTH);
    if (phrase === '') continue;
    if (kept.some((existing) => existing.toLowerCase() === phrase.toLowerCase())) continue;

    kept.push(phrase);
    if (kept.length === MAX_PHRASES) break;
  }

  return kept;
}

/**
 * Read whatever was in storage, and be suspicious of all of it.
 *
 * A preferences blob is the one thing in the app that survives a deploy, so it
 * is also the one thing most likely to be from an older version of this type.
 * Every field falls back independently rather than the whole object being
 * thrown away, so a player who gains a new preference does not lose their old
 * ones.
 */
export function parsePrefs(raw: unknown): Prefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFS;

  const value = raw as Record<string, unknown>;
  return {
    deck: value.deck === 'four-colour' ? 'four-colour' : 'classic',
    soundEnabled: value.soundEnabled === true,
    turnChime: value.turnChime === true,
    volume: clampVolume(value.volume),
    quickPhrases: Array.isArray(value.quickPhrases)
      ? normalisePhrases(value.quickPhrases.filter((p): p is string => typeof p === 'string'))
      : DEFAULT_PHRASES,
    mutedUserIds: Array.isArray(value.mutedUserIds)
      ? [...new Set(value.mutedUserIds.filter((id): id is string => typeof id === 'string'))]
      : [],
  };
}

/** Adding and removing without caring whether it was already there. */
export function toggleMuted(muted: readonly string[], userId: string): string[] {
  return muted.includes(userId) ? muted.filter((id) => id !== userId) : [...muted, userId];
}
