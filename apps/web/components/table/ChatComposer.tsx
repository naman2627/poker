'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { usePrefs } from '../../lib/prefs/store';
import { cx } from '../../lib/cx';

/**
 * Saying something.
 *
 * The server has accepted `chat:send` since the realtime layer was written and
 * the hand log has always rendered what came back — there was simply never a
 * box to type into. This is that box.
 *
 * The phrase chips above it are the point, though. Typing at a poker table
 * costs you the thing you are at the table for: you look down, you miss the
 * flop, and by the time you have written "nice hand" the moment it was about
 * has gone. One tap does not.
 *
 * `maxLength` matches `ChatSendSchema` in @poker/shared exactly, so the box
 * stops you at the same place the server would — and the server still checks
 * (CLAUDE.md §4); this only saves the round trip.
 */
const MAX_LENGTH = 280;

export interface ChatComposerProps {
  readonly disabled: boolean;
  onSend(text: string): void;
}

export function ChatComposer({ disabled, onSend }: ChatComposerProps) {
  const { quickPhrases, hydrate } = usePrefs();
  const [text, setText] = useState('');

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '' || disabled) return;
    onSend(trimmed.slice(0, MAX_LENGTH));
    setText('');
  };

  return (
    <div className="flex flex-col gap-2 border-t border-white/10 px-3 pt-2.5 pb-3">
      {quickPhrases.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Quick phrases" role="group">
          {quickPhrases.map((phrase) => (
            <button
              key={phrase}
              type="button"
              disabled={disabled}
              onClick={() => {
                onSend(phrase);
              }}
              className={cx(
                'rounded-full px-2.5 py-1 text-xs ring-1 transition-colors',
                'bg-white/5 text-neutral-300 ring-white/10',
                'hover:bg-white/10 hover:text-neutral-100',
                'disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              {phrase}
            </button>
          ))}
        </div>
      ) : null}

      <form onSubmit={submit} className="flex gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Message the table
        </label>
        <input
          id="chat-input"
          value={text}
          disabled={disabled}
          maxLength={MAX_LENGTH}
          autoComplete="off"
          placeholder="Say something…"
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          className={cx(
            'min-h-10 min-w-0 flex-1 rounded-lg bg-black/30 px-3 text-sm text-neutral-100',
            'ring-1 ring-white/10 placeholder:text-neutral-600',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        />
        <button
          type="submit"
          disabled={disabled || text.trim() === ''}
          className={cx(
            'min-h-10 rounded-lg px-3 text-xs font-semibold transition-colors',
            'bg-accent text-felt-950 hover:brightness-110',
            'disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          Send
        </button>
      </form>
    </div>
  );
}
