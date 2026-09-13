'use client';

import { useEffect, useRef } from 'react';
import type { ChatMessagePayload } from '@poker/shared';
import type { Announcement } from '../../lib/announce';
import { ChatComposer } from './ChatComposer';

/**
 * The hand log, and the thing that reads it aloud.
 *
 * The list is `aria-live="polite"`, so a screen reader announces "Naman raised
 * to 400" as it lands without cutting off whatever it was already saying. Only
 * pot awards go out assertively — those are worth interrupting for.
 *
 * The same strings do both jobs: what is read is exactly what is shown, so the
 * two cannot drift.
 */
export function HandLog({
  log,
  chat,
  canChat,
  onSend,
}: {
  log: readonly Announcement[];
  chat: readonly ChatMessagePayload[];
  /** False while the link is down — a message sent into a dead socket is lost. */
  canChat: boolean;
  onSend(text: string): void;
}) {
  const scroller = useRef<HTMLOListElement>(null);
  const latest = log[log.length - 1];

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log.length, chat.length]);

  return (
    <section
      aria-label="Hand log"
      className="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-black/25"
    >
      <h2 className="border-b border-white/10 px-4 py-2.5 text-[0.65rem] font-semibold tracking-[0.18em] text-neutral-400 uppercase">
        Hand log
      </h2>

      <ol
        ref={scroller}
        aria-live="polite"
        aria-relevant="additions"
        className="min-h-24 flex-1 space-y-1 overflow-y-auto px-4 py-3 text-sm text-neutral-300"
      >
        {log.length === 0 ? (
          <li className="text-neutral-500">Waiting for the first hand.</li>
        ) : (
          log.map((line) => <li key={line.id}>{line.text}</li>)
        )}
      </ol>

      {/*
        A second, assertive region. It holds only the most recent interrupting
        line, so a reader is told who won without being read the whole log again.
      */}
      <p aria-live="assertive" className="sr-only">
        {latest?.assertive === true ? latest.text : ''}
      </p>

      {chat.length > 0 ? (
        <ul className="max-h-28 space-y-1 overflow-y-auto border-t border-white/10 px-4 py-2.5 text-sm">
          {chat.map((message) => (
            <li key={`${message.userId}-${String(message.at)}`}>
              <span className="text-accent font-medium">{message.displayName}</span>{' '}
              <span className="text-neutral-300">{message.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <ChatComposer disabled={!canChat} onSend={onSend} />
    </section>
  );
}
