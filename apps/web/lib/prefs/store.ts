'use client';

import { create } from 'zustand';
import { primeAudio } from '../sound/engine';
import {
  DEFAULT_PREFS,
  clampVolume,
  normalisePhrases,
  parsePrefs,
  toggleMuted,
  type DeckStyle,
  type Prefs,
} from './prefs';

/**
 * One store for everything a player has decided about their table.
 *
 * `localStorage` rather than `sessionStorage`: unlike the access token in
 * `auth/session.ts` these are preferences, not credentials. Somebody who turned
 * the chime on last night wants it on tonight, and there is nothing in here
 * worth protecting from the next person to use the machine.
 *
 * It replaces the sound-only store that came before it. Keeping two would mean
 * two keys, two hydrations and two chances for the settings page and the table
 * to disagree about whether sound is on.
 */
interface PrefsStore extends Prefs {
  readonly hydrated: boolean;
  hydrate(): void;
  setDeck(deck: DeckStyle): void;
  setSoundEnabled(enabled: boolean): void;
  setTurnChime(enabled: boolean): void;
  setVolume(volume: number): void;
  setQuickPhrases(input: string | readonly string[]): void;
  toggleMute(userId: string): void;
}

const KEY = 'poker.prefs';

export const usePrefs = create<PrefsStore>((set, get) => {
  const commit = (patch: Partial<Prefs>): void => {
    const next: Prefs = { ...current(get()), ...patch };
    write(next);
    set(next);
  };

  return {
    ...DEFAULT_PREFS,
    hydrated: false,

    hydrate() {
      if (get().hydrated) return;
      set({ ...read(), hydrated: true });
    },

    setDeck(deck) {
      commit({ deck });
    },

    setSoundEnabled(soundEnabled) {
      // Turning a sound on is a click, and a click is the one moment a browser
      // will let an AudioContext start. Doing it here means the first sound the
      // player hears is the next thing that happens, not the one after that.
      if (soundEnabled) primeAudio();
      commit({ soundEnabled });
    },

    setTurnChime(turnChime) {
      if (turnChime) primeAudio();
      commit({ turnChime });
    },

    setVolume(volume) {
      commit({ volume: clampVolume(volume) });
    },

    setQuickPhrases(input) {
      commit({ quickPhrases: normalisePhrases(input) });
    },

    toggleMute(userId) {
      commit({ mutedUserIds: toggleMuted(get().mutedUserIds, userId) });
    },
  };
});

function current(store: Prefs): Prefs {
  return {
    deck: store.deck,
    soundEnabled: store.soundEnabled,
    turnChime: store.turnChime,
    volume: store.volume,
    quickPhrases: store.quickPhrases,
    mutedUserIds: store.mutedUserIds,
  };
}

function read(): Prefs {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw === null ? DEFAULT_PREFS : parsePrefs(JSON.parse(raw));
  } catch {
    // Private browsing, a cleared store, a half-written value. Start from the
    // defaults, which is also what a first-time visitor gets.
    return DEFAULT_PREFS;
  }
}

function write(prefs: Prefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // The preference simply will not survive a reload.
  }
}
