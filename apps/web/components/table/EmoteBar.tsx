'use client';

import { useEffect, useState } from 'react';
import type { Emote } from '@poker/shared';
import { EMOTE_LOOKS } from '../../lib/emotes';
import { cx } from '../../lib/cx';

/**
 * The six reactions, for somebody sitting at the table.
 *
 * The cooldown drawn here is a copy of the server's, not the rule itself — the
 * rule is in `TableRuntime.emote` and a client that ignores this is refused
 * (CLAUDE.md §4). What it buys is the thing a refusal cannot: a button that
 * visibly cannot be pressed, instead of one that can be pressed and then does
 * nothing.
 *
 * It is only rendered for a seated player. A reaction floats over a chair, and
 * somebody on the rail has none — the server refuses them for the same reason.
 */
export interface EmoteBarProps {
  readonly disabled: boolean;
  /** Milliseconds the server will refuse for, matching `EMOTE_COOLDOWN_MS`. */
  readonly cooldownMs: number;
  onEmote(emote: Emote): void;
}

export function EmoteBar({ disabled, cooldownMs, onEmote }: EmoteBarProps) {
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The clock only runs while something is actually cooling down.
  useEffect(() => {
    if (sentAt === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 120);
    return () => {
      clearInterval(timer);
    };
  }, [sentAt]);

  const remaining = sentAt === null ? 0 : Math.max(0, sentAt + cooldownMs - now);
  const cooling = remaining > 0;

  return (
    <div
      role="group"
      aria-label="React"
      className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-white/10 bg-black/25 px-3 py-2"
    >
      {EMOTE_LOOKS.map((look) => (
        <button
          key={look.id}
          type="button"
          disabled={disabled || cooling}
          aria-label={look.label}
          title={look.label}
          onClick={() => {
            onEmote(look.id);
            setSentAt(Date.now());
            setNow(Date.now());
          }}
          className={cx(
            'grid size-9 place-items-center rounded-lg text-lg transition-transform',
            'hover:bg-white/10 active:scale-90',
            'disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent',
          )}
        >
          <span aria-hidden>{look.glyph}</span>
        </button>
      ))}

      <span
        aria-live="polite"
        className="tabular ml-auto min-w-14 text-right text-[0.7rem] text-neutral-500"
      >
        {cooling ? `${String(Math.ceil(remaining / 1000))}s` : ''}
      </span>
    </div>
  );
}
