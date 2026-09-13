'use client';

import { useEffect, useState } from 'react';
import type { EmotePayload } from '@poker/shared';
import { EMOTE_LIFETIME_MS, type FloatingEmote } from './emotes';
import { usePrefs } from './prefs/store';

/**
 * Which reactions are still on the felt.
 *
 * The store keeps every reaction that arrived; this decides which of them are
 * still worth drawing. That split matters: "what happened" is state and belongs
 * to the store, while "what is still on screen" is a question about a clock,
 * and putting a timer in the store would make a reaction fading out look like a
 * table update.
 *
 * The answer is *derived* rather than held — a reaction is on screen while it
 * is younger than `EMOTE_LIFETIME_MS`, and the only state here is the clock
 * that makes that recompute. Holding a list and expiring it with timers would
 * mean writing state from inside an effect, which cascades renders for no gain.
 *
 * Muting is applied here rather than in the store, so unmuting somebody does
 * not make three of their old reactions suddenly appear.
 */
export function useLiveEmotes(
  arrivals: readonly (EmotePayload & { seq: number; receivedAt: number })[],
): FloatingEmote[] {
  const muted = usePrefs((store) => store.mutedUserIds);
  const [now, setNow] = useState(() => Date.now());

  const newest = arrivals[arrivals.length - 1];
  const newestSeq = newest?.seq ?? 0;

  useEffect(() => {
    if (newestSeq === 0) return;

    // A clock, but only for as long as the newest reaction could still be up.
    // It stops on its own rather than ticking for the rest of the session.
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 200);
    const stop = setTimeout(() => {
      clearInterval(timer);
      setNow(Date.now());
    }, EMOTE_LIFETIME_MS + 250);

    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [newestSeq]);

  return arrivals
    .filter((arrival) => !muted.includes(arrival.userId))
    .filter((arrival) => now - arrival.receivedAt < EMOTE_LIFETIME_MS)
    .map((arrival) => ({
      key: String(arrival.seq),
      seatIndex: arrival.seatIndex,
      emote: arrival.emote,
    }));
}
