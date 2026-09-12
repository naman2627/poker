'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { HandDetail, HandSummary, HandVerification } from '@poker/shared';
import { useSession } from '../../lib/auth/session';
import {
  HistoryRequestError,
  fetchHand,
  fetchHandHistory,
  fetchVerification,
} from '../../lib/history/api';
import { parseCardCodes } from '../../lib/history/cards';
import { chips } from '../../lib/format';
import { PlayingCard } from '../table/PlayingCard';
import { Button } from '../ui/Button';
import { Shell } from '../ui/Shell';
import { FairnessPanel } from './FairnessPanel';
import { HandReplay } from './HandReplay';

/**
 * The last fifty hands at a table.
 *
 * A summary each, and a replay behind each one. The detail is fetched when a
 * hand is opened rather than all at once — fifty hands of actions is a lot to
 * carry for a list most people scroll past.
 */
export function HandHistory({ code }: { code: string }) {
  const router = useRouter();
  const { session, hydrate, hydrated } = useSession();

  const [hands, setHands] = useState<HandSummary[] | null>(null);
  const [status, setStatus] = useState<{ paused: boolean; pending: number }>({
    paused: false,
    pending: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [openHandId, setOpenHandId] = useState<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (hydrated && session === null) router.replace('/');
  }, [hydrated, router, session]);

  const token = session?.accessToken ?? null;

  useEffect(() => {
    if (token === null) return;
    let cancelled = false;

    void fetchHandHistory(token, code)
      .then((response) => {
        if (cancelled) return;
        setHands(response.hands);
        setStatus({ paused: response.statsPaused, pending: response.pendingWrites });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof HistoryRequestError ? caught.body.message : 'that did not work');
      });

    return () => {
      cancelled = true;
    };
  }, [code, token]);

  return (
    <Shell>
      <div className="mx-auto flex min-h-dvh max-w-3xl flex-col gap-5 px-4 py-6">
        <header className="flex flex-wrap items-center gap-3">
          <Button variant="quiet" className="px-0" onClick={() => router.push(`/table/${code}`)}>
            &larr; Table
          </Button>
          <h1 className="tabular text-lg font-semibold tracking-[0.25em] text-neutral-50">
            {code}
          </h1>
          <p className="text-xs text-neutral-500">Hand history</p>
        </header>

        {status.paused ? (
          <p
            role="status"
            className="rounded-xl border border-amber-300/30 bg-amber-300/5 px-4 py-2.5 text-sm text-amber-200"
          >
            Statistics are paused — the table is not. {chips(status.pending)} record
            {status.pending === 1 ? '' : 's'} are waiting to be written, so the most recent hands
            may not be here yet.
          </p>
        ) : null}

        {error !== null ? (
          <p
            role="alert"
            className="border-danger/40 text-danger rounded-xl border bg-black/40 px-4 py-2.5 text-sm"
          >
            {error}
          </p>
        ) : null}

        {hands === null && error === null ? (
          <p className="text-sm text-neutral-500">Reading the record…</p>
        ) : null}

        {hands !== null && hands.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-black/25 px-4 py-3 text-sm text-neutral-400">
            No hands here yet. They appear as they finish.
          </p>
        ) : null}

        <ol className="space-y-2">
          {(hands ?? []).map((hand) => (
            <HandRow
              key={hand.id}
              hand={hand}
              token={token}
              open={openHandId === hand.id}
              onToggle={() => {
                setOpenHandId((current) => (current === hand.id ? null : hand.id));
              }}
            />
          ))}
        </ol>
      </div>
    </Shell>
  );
}

function HandRow({
  hand,
  token,
  open,
  onToggle,
}: {
  hand: HandSummary;
  token: string | null;
  open: boolean;
  onToggle(): void;
}) {
  const [detail, setDetail] = useState<HandDetail | null>(null);
  const [fairness, setFairness] = useState<HandVerification | null>(null);
  const [showFairness, setShowFairness] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || token === null || detail !== null) return;
    let cancelled = false;

    void fetchHand(token, hand.id)
      .then((found) => {
        if (!cancelled) setDetail(found);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof HistoryRequestError ? caught.body.message : 'that did not work');
      });

    return () => {
      cancelled = true;
    };
  }, [detail, hand.id, open, token]);

  const loadFairness = (): void => {
    setShowFairness(true);
    if (token === null || fairness !== null) return;

    void fetchVerification(token, hand.id)
      .then(setFairness)
      .catch((caught: unknown) => {
        setError(
          caught instanceof HistoryRequestError
            ? caught.body.message
            : 'could not verify that hand',
        );
      });
  };

  const board = parseCardCodes(hand.board);
  const winners = hand.winners.map((winner) => winner.displayName).join(', ');

  return (
    <li className="overflow-hidden rounded-xl border border-white/10 bg-black/25">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-white/5"
      >
        <span className="tabular w-12 shrink-0 text-xs text-neutral-500">#{hand.handNumber}</span>

        <span className="flex shrink-0 -space-x-2">
          {board.length === 0 ? (
            <span className="text-xs text-neutral-600">no board</span>
          ) : (
            board.map((card) => (
              <PlayingCard key={`${String(card.rank)}${card.suit}`} card={card} size="sm" />
            ))
          )}
        </span>

        <span className="min-w-0 flex-1 truncate text-sm text-neutral-300">
          {winners === '' ? 'unfinished' : `${winners} won`}
        </span>

        <span className="tabular shrink-0 text-sm font-semibold text-neutral-100">
          {chips(hand.totalPot)}
        </span>
        <span aria-hidden className="shrink-0 text-neutral-500">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-white/10 px-4 py-4">
          {error !== null ? (
            <p role="alert" className="text-danger text-sm">
              {error}
            </p>
          ) : null}

          {detail === null && error === null ? (
            <p className="text-sm text-neutral-500">Reading the hand…</p>
          ) : null}

          {detail !== null ? <HandReplay hand={detail} /> : null}

          <div className="border-t border-white/10 pt-3">
            {showFairness ? (
              fairness === null ? (
                <p className="text-sm text-neutral-500">Recomputing the deal…</p>
              ) : (
                <FairnessPanel result={fairness} />
              )
            ) : (
              <Button variant="ghost" className="min-h-9 px-3 text-xs" onClick={loadFairness}>
                Was this deal straight?
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}
