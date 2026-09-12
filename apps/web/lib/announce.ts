import type { PublicTableState, TableEvent } from '@poker/shared';
import { cardLabel } from './cards';
import { chips } from './format';

/**
 * What just happened, in a sentence.
 *
 * The same string does two jobs: it goes into the hand log, and it goes into the
 * `aria-live` region so a player who is not looking at the felt hears "Naman
 * raised to 400" at the moment everybody else sees the chips move. Both readings
 * come from the same event, so they cannot drift apart.
 *
 * Names are looked up in the state that was current when the event arrived; a
 * seat that has since been vacated falls back to its number rather than
 * disappearing from the log.
 */
export interface Announcement {
  readonly id: string;
  readonly text: string;
  /** Set on the handful of events worth interrupting a screen reader for. */
  readonly assertive: boolean;
}

export function announce(
  event: TableEvent,
  state: PublicTableState | null,
  id: string,
): Announcement | null {
  const name = (value: unknown): string => {
    const seatIndex = typeof value === 'number' ? value : -1;
    const seat = state?.seats[seatIndex];
    return seat?.displayName ?? `Seat ${String(seatIndex + 1)}`;
  };
  const say = (text: string, assertive = false): Announcement => ({ id, text, assertive });

  switch (event.type) {
    case 'HAND_STARTED':
      return say(`Hand ${String(numberOf(event.handNumber))} begins.`);

    case 'BLIND_POSTED':
      return say(
        `${name(event.seatIndex)} posts the ${String(event.blind)} blind, ${chips(numberOf(event.amount))}.`,
      );

    case 'PLAYER_ACTED':
      return say(actionSentence(name(event.seatIndex), event));

    case 'ACTION_TIMED_OUT':
      return say(
        `${name(event.seatIndex)} ran out of time and ${event.appliedAction === 'FOLD' ? 'folded' : 'checked'}.`,
      );

    case 'BOARD_DEALT': {
      const cards = cardList(event.cards);
      const street = String(event.phase);
      return cards === null ? null : say(`The ${street}: ${cards}.`);
    }

    case 'HAND_REVEALED': {
      const cards = cardList(event.cards);
      return cards === null
        ? null
        : say(`${name(event.seatIndex)} shows ${cards} — ${String(event.handName)}.`);
    }

    case 'HAND_MUCKED':
      return say(`${name(event.seatIndex)} mucks.`);

    case 'PLAYER_SITTING_OUT_CHANGED':
      return say(
        event.sittingOut === true
          ? `${name(event.seatIndex)} is sitting out the next hand.`
          : `${name(event.seatIndex)} is in for the next hand.`,
      );

    case 'PLAYER_LEAVE_PENDING':
      return say(`${name(event.seatIndex)} is standing up.`);

    case 'POT_AWARDED':
      return say(
        `${name(event.seatIndex)} wins ${chips(numberOf(event.amount))}${
          numberOf(event.potIndex) > 0 ? ` from side pot ${String(numberOf(event.potIndex))}` : ''
        }.`,
        true,
      );

    case 'PLAYER_SAT':
      return say(`${name(event.seatIndex)} sits down with ${chips(numberOf(event.stack))}.`);

    case 'PLAYER_LEFT':
      return say(`${name(event.seatIndex)} leaves the table.`);

    case 'HAND_ENDED':
      return say('Hand complete.');

    // Turn order, phase bookkeeping and the showdown marker are already visible
    // on the felt; narrating them as well only adds noise.
    default:
      return null;
  }
}

function actionSentence(who: string, event: TableEvent): string {
  const to = chips(numberOf(event.committedThisRound));
  const allIn = event.allIn === true;

  switch (event.action) {
    case 'FOLD':
      return `${who} folds.`;
    case 'CHECK':
      return `${who} checks.`;
    case 'CALL':
      return allIn ? `${who} calls all in for ${to}.` : `${who} calls ${to}.`;
    case 'BET':
      return allIn ? `${who} bets ${to} and is all in.` : `${who} bets ${to}.`;
    case 'RAISE':
      return allIn ? `${who} raises to ${to} and is all in.` : `${who} raises to ${to}.`;
    case 'ALL_IN':
      return `${who} is all in for ${to}.`;
    default:
      return `${who} acts.`;
  }
}

function cardList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const labels: string[] = [];

  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { rank, suit } = item as { rank?: unknown; suit?: unknown };
    if (typeof rank !== 'number') return null;
    if (suit !== 's' && suit !== 'h' && suit !== 'd' && suit !== 'c') return null;
    labels.push(cardLabel({ rank, suit }));
  }

  return labels.length === 0 ? null : labels.join(', ');
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
