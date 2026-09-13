'use client';

import { useEffect, useRef } from 'react';
import type { ActionPromptPayload, TableEvent } from '@poker/shared';
import { playSound } from './engine';
import { shouldPlay, soundsForPatch } from './sounds';
import { usePrefs } from '../prefs/store';

/**
 * The table, out loud.
 *
 * Two sources, deliberately different:
 *
 *   the five table sounds come from the public event stream, so everybody at
 *   the table hears the same fold at the same moment
 *
 *   the your-turn chime comes from `action:prompt`, which the server addresses
 *   to one player. Deriving it from the event stream instead would mean every
 *   client working out whose turn it is, which is a rule, and rules are the
 *   server's (CLAUDE.md §2). The prompt already says "you, now".
 *
 * Nothing here decides *whether* to make a noise beyond asking `shouldPlay`;
 * the two switches are in `sounds.ts` and are tested there.
 */
export interface TableSoundsInput {
  /** The store's latest patch. A new `seq` is a new thing to react to. */
  readonly patch: { readonly seq: number; readonly events: readonly TableEvent[] } | null;
  readonly prompt: ActionPromptPayload | null;
  readonly viewerSeatIndex: number | null;
}

export function useTableSounds({ patch, prompt, viewerSeatIndex }: TableSoundsInput): void {
  const enabled = usePrefs((store) => store.soundEnabled);
  const turnChime = usePrefs((store) => store.turnChime);
  const volume = usePrefs((store) => store.volume);

  /**
   * The patch this hook has already voiced.
   *
   * React runs effects again for reasons that have nothing to do with new
   * events — a re-render, a preference toggling, Strict Mode double-invoking in
   * development. Without this, flipping the sound switch would replay whatever
   * happened last.
   */
  const spokenPatch = useRef<number>(0);

  useEffect(() => {
    if (patch === null) return;
    if (patch.seq <= spokenPatch.current) return;
    spokenPatch.current = patch.seq;

    // Read the preference at the moment the events land, not at subscribe time.
    if (!enabled) return;
    for (const name of soundsForPatch(patch.events, viewerSeatIndex)) {
      if (shouldPlay(name, { enabled, turnChime })) playSound(name, volume);
    }
  }, [patch, enabled, turnChime, volume, viewerSeatIndex]);

  /**
   * The chime, once per turn.
   *
   * A prompt is re-sent on a resync and on every reconnect, so "a prompt
   * arrived" is not the same as "it is now your turn". The hand and the action
   * number together are, so that is what is remembered.
   */
  const chimedFor = useRef<string | null>(null);

  useEffect(() => {
    const mine =
      prompt !== null && viewerSeatIndex !== null && prompt.seatIndex === viewerSeatIndex;
    if (!mine || prompt === null) {
      chimedFor.current = null;
      return;
    }

    const turn = `${prompt.handId}:${String(prompt.actionSeq)}`;
    if (chimedFor.current === turn) return;
    chimedFor.current = turn;

    if (shouldPlay('turn', { enabled, turnChime })) playSound('turn', volume);
  }, [prompt, viewerSeatIndex, enabled, turnChime, volume]);
}
