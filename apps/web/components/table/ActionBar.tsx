'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionPromptPayload, PlayerActionPayload, PlayerActionType } from '@poker/shared';
import { Button } from '../ui/Button';
import { RaiseControl } from './RaiseControl';
import { raiseBounds, snapRaise } from '../../lib/raise';
import { chips } from '../../lib/format';
import { cx } from '../../lib/cx';

/**
 * The action bar, which only the seated viewer ever sees.
 *
 * What is offered comes from `action:prompt` and nowhere else: if the server did
 * not say a player can check, there is no check button to press. The bar
 * disables itself the moment something is clicked — the one piece of optimism in
 * this client (see `lib/store/table-store.ts`) — and the server's answer decides
 * what happens next.
 *
 * Keyboard: F folds, C checks or calls, R opens the raise panel, Enter confirms.
 * The shortcuts are ignored while a text field has focus, so typing in chat
 * cannot fold a hand.
 */
export interface ActionBarProps {
  readonly prompt: ActionPromptPayload;
  readonly bigBlind: number;
  readonly potTotal: number;
  readonly currentBet: number;
  readonly pending: boolean;
  act(action: PlayerActionPayload): void;
}

export function ActionBar({
  prompt,
  bigBlind,
  potTotal,
  currentBet,
  pending,
  act,
}: ActionBarProps) {
  const legal = prompt.legalActions;
  const bounds = raiseBounds(legal, bigBlind);
  const canOpenRaise = legal.canBet || legal.canRaise;

  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(() => snapRaise(bounds.min, bounds));

  // A new prompt is a new decision: the panel closes and the slider goes back to
  // the smallest legal amount rather than keeping a number from the last street.
  const promptKey = `${prompt.handId}:${String(prompt.actionSeq)}`;
  const [seenPrompt, setSeenPrompt] = useState(promptKey);
  if (seenPrompt !== promptKey) {
    setSeenPrompt(promptKey);
    setRaising(false);
    setAmount(snapRaise(bounds.min, bounds));
  }

  const send = useCallback(
    (type: PlayerActionType, value?: number) => {
      if (pending) return;
      act({
        handId: prompt.handId,
        actionSeq: prompt.actionSeq,
        type,
        ...(value === undefined ? {} : { amount: value }),
      });
    },
    [act, pending, prompt.actionSeq, prompt.handId],
  );

  const confirmRaise = useCallback(() => {
    send(legal.canBet && !legal.canRaise ? 'BET' : 'RAISE', snapRaise(amount, bounds));
  }, [amount, bounds, legal.canBet, legal.canRaise, send]);

  useShortcuts({
    disabled: pending,
    onFold: legal.canFold ? () => send('FOLD') : null,
    onCheckCall: legal.canCheck ? () => send('CHECK') : legal.canCall ? () => send('CALL') : null,
    onRaise: canOpenRaise
      ? () => {
          setRaising(true);
        }
      : null,
    onConfirm: raising && canOpenRaise ? confirmRaise : null,
  });

  return (
    <section
      aria-label="Your action"
      className={cx(
        'fixed inset-x-0 bottom-0 z-30 border-t border-white/10',
        'bg-felt-950/95 px-3 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur',
        'sm:static sm:rounded-2xl sm:border sm:border-white/10 sm:p-4 sm:backdrop-blur-none',
      )}
    >
      {raising && canOpenRaise ? (
        <div className="space-y-3">
          <RaiseControl
            legal={legal}
            bigBlind={bigBlind}
            potTotal={potTotal}
            currentBet={currentBet}
            value={amount}
            disabled={pending}
            onChange={setAmount}
            onConfirm={confirmRaise}
          />
          <Button
            variant="quiet"
            className="w-full"
            onClick={() => {
              setRaising(false);
            }}
          >
            Back
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            data-testid="action-fold"
            disabled={pending || !legal.canFold}
            onClick={() => {
              send('FOLD');
            }}
            className="flex-1"
          >
            Fold <Key>F</Key>
          </Button>

          {legal.canCheck ? (
            <Button
              variant="secondary"
              data-testid="action-check"
              disabled={pending}
              onClick={() => {
                send('CHECK');
              }}
              className="flex-1"
            >
              Check <Key>C</Key>
            </Button>
          ) : (
            <Button
              variant="secondary"
              data-testid="action-call"
              disabled={pending || !legal.canCall}
              onClick={() => {
                send('CALL');
              }}
              className="flex-1"
            >
              <span className="tabular">Call {chips(legal.callAmount)}</span> <Key>C</Key>
            </Button>
          )}

          <Button
            variant="primary"
            data-testid="action-raise"
            disabled={pending || !canOpenRaise}
            onClick={() => {
              setRaising(true);
            }}
            className="flex-1"
          >
            {legal.canBet && !legal.canRaise ? 'Bet' : 'Raise'} <Key>R</Key>
          </Button>
        </div>
      )}
    </section>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden
      className="hidden rounded border border-current/30 px-1 text-[0.6rem] opacity-60 sm:inline"
    >
      {children}
    </kbd>
  );
}

/**
 * The keyboard shortcuts.
 *
 * Held in a ref so the listener is attached once and never sees a stale closure;
 * re-binding a `keydown` on every render of a bar that re-renders on every clock
 * tick would be a lot of churn for no benefit.
 */
function useShortcuts(handlers: {
  disabled: boolean;
  onFold: (() => void) | null;
  onCheckCall: (() => void) | null;
  onRaise: (() => void) | null;
  onConfirm: (() => void) | null;
}): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = latest.current;
      if (current.disabled || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;

      const run = (handler: (() => void) | null): void => {
        if (!handler) return;
        event.preventDefault();
        handler();
      };

      switch (event.key.toLowerCase()) {
        case 'f':
          return run(current.onFold);
        case 'c':
          return run(current.onCheckCall);
        case 'r':
          return run(current.onRaise);
        case 'enter':
          return run(current.onConfirm);
        default:
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}

/** A shortcut must never fire while somebody is writing a chat message. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // A range input is the raise slider: arrow keys move it, but F and R should
  // still work while it has focus.
  return tag === 'INPUT' && target.getAttribute('type') !== 'range';
}
