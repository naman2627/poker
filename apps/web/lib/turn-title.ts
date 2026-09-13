'use client';

import { useEffect, useRef } from 'react';

/**
 * "Your turn", in the tab title, for a player who is looking at something else.
 *
 * This is the companion to the chime and it exists for the same person: the one
 * who has the table behind their work. A sound tells them something happened; a
 * flashing title tells them it is still happening and it is theirs.
 *
 * Two rules it must not break:
 *
 *   it stops the instant the tab is looked at, because a title that keeps
 *   flashing at somebody who is already reading it is just noise
 *
 *   it puts the original title back. Exactly. A page left saying "Your turn"
 *   after the hand moved on is worse than never having flashed at all
 */

/** The flashing half of the alternation. */
export const TURN_TITLE = '🔔 Your turn';

/** How fast it alternates. Slow enough to read, fast enough to catch the eye. */
export const FLASH_MS = 1_000;

/**
 * Whether the title should be flashing at all.
 *
 * Pure, and the only real decision in this file: it is your turn, and you are
 * not looking. Either half being false means silence.
 */
export function shouldFlashTitle(input: { myTurn: boolean; hidden: boolean }): boolean {
  return input.myTurn && input.hidden;
}

/** What the tab should say on a given tick. */
export function titleForTick(base: string, tick: number): string {
  return tick % 2 === 0 ? TURN_TITLE : base;
}

/**
 * Drive `document.title` while it is the viewer's turn and the tab is hidden.
 *
 * The original title is captured when flashing *starts* rather than when the
 * hook mounts, so a page that legitimately changes its own title in between
 * gets its current one back rather than a stale one.
 */
export function useTurnTitleFlash(myTurn: boolean): void {
  const original = useRef<string | null>(null);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    let tick = 0;
    let timer: ReturnType<typeof setInterval> | null = null;

    const restore = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (original.current !== null) {
        document.title = original.current;
        original.current = null;
      }
    };

    const sync = (): void => {
      const flashing = shouldFlashTitle({ myTurn, hidden: document.hidden });

      if (!flashing) {
        restore();
        return;
      }
      if (timer !== null) return;

      original.current = document.title;
      tick = 0;
      document.title = titleForTick(original.current, tick);

      timer = setInterval(() => {
        tick += 1;
        // `original.current` is set above and cleared only by `restore`, which
        // also clears this interval.
        if (original.current !== null) document.title = titleForTick(original.current, tick);
      }, FLASH_MS);
    };

    sync();
    document.addEventListener('visibilitychange', sync);
    // `focus` is belt and braces: some browsers restore a background tab
    // without firing visibilitychange when the whole window regains focus.
    window.addEventListener('focus', sync);

    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      restore();
    };
  }, [myTurn]);
}
