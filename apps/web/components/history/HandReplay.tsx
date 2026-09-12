'use client';

import { useState } from 'react';
import type { HandDetail } from '@poker/shared';
import { PlayingCard } from '../table/PlayingCard';
import { Button } from '../ui/Button';
import { parseCardCodes } from '../../lib/history/cards';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * One hand, step by step.
 *
 * Driven entirely by `hand_actions`: every row is a step, and the board beside
 * it is the board as it stood after that step. Nothing here reconstructs the
 * hand — it reads what was recorded, in the order it was recorded, which is what
 * makes a replay an account of what happened rather than a plausible retelling.
 */
export function HandReplay({ hand }: { hand: HandDetail }) {
  const [step, setStep] = useState(hand.actions.length);
  const shown = hand.actions.slice(0, step);
  const current = hand.actions[Math.max(0, step - 1)];
  const board = parseCardCodes(current?.board ?? hand.board);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          className="min-h-9 px-3 text-xs"
          disabled={step <= 0}
          onClick={() => {
            setStep((value) => Math.max(0, value - 1));
          }}
        >
          &larr; Back
        </Button>
        <Button
          variant="ghost"
          className="min-h-9 px-3 text-xs"
          disabled={step >= hand.actions.length}
          onClick={() => {
            setStep((value) => Math.min(hand.actions.length, value + 1));
          }}
        >
          Step &rarr;
        </Button>
        <Button
          variant="quiet"
          className="min-h-9 px-3 text-xs"
          onClick={() => {
            setStep(hand.actions.length);
          }}
        >
          To the end
        </Button>

        <p className="tabular ml-auto text-xs text-neutral-500">
          step {step} of {hand.actions.length}
          {current ? ` · ${current.street}` : ''}
        </p>
      </div>

      <div className="flex min-h-[4.5rem] flex-wrap items-center gap-2 rounded-xl bg-black/25 p-3">
        {board.length === 0 ? (
          <p className="text-xs text-neutral-500">No board yet.</p>
        ) : (
          board.map((card) => (
            <PlayingCard key={`${String(card.rank)}${card.suit}`} card={card} size="sm" />
          ))
        )}
        <p className="tabular ml-auto text-sm font-semibold text-neutral-100">
          Pot {chips(current?.potAfter ?? hand.totalPot)}
        </p>
      </div>

      <ol className="max-h-72 space-y-1 overflow-y-auto text-sm">
        {shown.map((action, index) => (
          <li
            key={action.seq}
            className={cx(
              'flex items-baseline gap-2 rounded px-2 py-1',
              index === shown.length - 1 ? 'bg-accent/10 text-neutral-100' : 'text-neutral-400',
            )}
          >
            <span className="tabular w-10 shrink-0 text-xs text-neutral-600">
              {(action.elapsedMs / 1000).toFixed(1)}s
            </span>
            <span className="min-w-0 flex-1">{describe(action)}</span>
            <span className="tabular shrink-0 text-xs text-neutral-500">
              {chips(action.potAfter)}
            </span>
          </li>
        ))}
        {shown.length === 0 ? <li className="px-2 text-neutral-500">Before the deal.</li> : null}
      </ol>

      <Seats hand={hand} />
    </div>
  );
}

/** The stored action, as a sentence. */
function describe(action: HandDetail['actions'][number]): string {
  const who = action.displayName || (action.seatIndex === null ? 'The dealer' : 'A player');

  switch (action.action) {
    case 'POST_SMALL_BLIND':
      return `${who} posts the small blind, ${chips(action.amount)}.`;
    case 'POST_BIG_BLIND':
      return `${who} posts the big blind, ${chips(action.amount)}.`;
    case 'DEAL':
      return `The ${action.street}.`;
    case 'FOLD':
      return `${who} folds.`;
    case 'CHECK':
      return `${who} checks.`;
    case 'CALL':
      return `${who} calls ${chips(action.amount)}.`;
    case 'BET':
      return `${who} bets ${chips(action.amount)}.`;
    case 'RAISE':
      return `${who} raises to ${chips(action.amount)}.`;
    case 'ALL_IN':
      return `${who} is all in for ${chips(action.amount)}.`;
    case 'TIMEOUT_FOLD':
      return `${who} ran out of time and folded.`;
    case 'TIMEOUT_CHECK':
      return `${who} ran out of time and checked.`;
    case 'SHOW':
      return `${who} shows.`;
    case 'MUCK':
      return `${who} mucks.`;
    case 'WIN':
      return `${who} wins ${chips(action.amount)}.`;
    default:
      return `${who}: ${action.action}.`;
  }
}

function Seats({ hand }: { hand: HandDetail }) {
  return (
    <ul className="space-y-2 border-t border-white/10 pt-3">
      {hand.players.map((player) => {
        const cards = player.holeCards === null ? [] : parseCardCodes(player.holeCards);

        return (
          <li key={player.seatIndex} className="flex items-center gap-3">
            <span className="flex w-16 shrink-0 -space-x-2">
              {cards.length > 0 ? (
                cards.map((card) => (
                  <PlayingCard key={`${String(card.rank)}${card.suit}`} card={card} size="sm" />
                ))
              ) : (
                <span className="text-[0.65rem] tracking-wide text-neutral-600 uppercase">
                  mucked
                </span>
              )}
            </span>

            <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
              {player.displayName}
              {player.won ? <span className="text-accent"> · won</span> : null}
            </span>

            <span
              className={cx(
                'tabular shrink-0 text-sm font-semibold',
                (player.net ?? 0) > 0
                  ? 'text-accent'
                  : (player.net ?? 0) < 0
                    ? 'text-neutral-400'
                    : 'text-neutral-500',
              )}
            >
              {(player.net ?? 0) > 0 ? '+' : ''}
              {chips(player.net ?? 0)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
