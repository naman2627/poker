import type { EngineEvent, TableState } from '@poker/engine';
import {
  SERVER_EVENTS,
  type ActionPromptPayload,
  type ChatMessagePayload,
  type EmotePayload,
  type HandDealtPayload,
  type HandResultPayload,
  type LiveLeaderboardRow,
  type StatePatchPayload,
  type DeckRevealedPayload,
  type StateSyncPayload,
  type TableErrorPayload,
} from '@poker/shared';
import { liveLeaderboard, redactFor, type RedactionContext } from './redact';

/**
 * The only place in the codebase that puts table state on a socket.
 *
 * Every path that shows a client anything about the table goes through
 * `sendStateSync` or `sendStatePatch` here, and `sendStateSync` is the only
 * caller of `redactFor()` outside its own tests. Keeping that true is what makes
 * "no client ever sees a card it is not entitled to" a property of one file
 * instead of a habit spread across handlers.
 *
 * A `Connection` is one socket. The realtime layer wraps Socket.IO in it; tests
 * can wrap anything.
 */
export interface Connection {
  readonly socketId: string;
  readonly userId: string;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

export function sendStateSync(
  connection: Connection,
  version: number,
  state: TableState,
  context: RedactionContext,
): void {
  const payload: StateSyncPayload = {
    version,
    state: redactFor(state, connection.userId, context),
  };
  connection.emit(SERVER_EVENTS.stateSync, payload);
}

/**
 * Deltas during play.
 *
 * Engine events are public by construction — the only cards in them are board
 * cards and the hands a showdown turned face up — so a patch is the same for
 * everyone. `assertNoPrivateCards` holds that line if the engine ever changes.
 *
 * The live board rides along, recomputed from the state the patch describes.
 * Nearly every event moves a stack, so a board that waited for the next whole
 * sync would spend most of a hand showing the stacks from the last street. It is
 * built by `liveLeaderboard` in redact.ts rather than assembled here, so table
 * state still leaves through one file (CLAUDE.md §1) — and, like the events, it
 * is the same for every viewer, which is why it can be built once per publish
 * rather than once per socket.
 */
export function sendStatePatch(
  connection: Connection,
  version: number,
  events: readonly EngineEvent[],
  leaderboard: readonly LiveLeaderboardRow[],
): void {
  const payload: StatePatchPayload = {
    version,
    events: events.map(assertNoPrivateCards),
    leaderboard,
  };
  connection.emit(SERVER_EVENTS.statePatch, payload);
}

/**
 * The live board for one publish, built once and sent to everybody.
 *
 * Exported so the runtime can build it a single time per broadcast instead of
 * once per connected socket, without reaching past this file for it.
 */
export function leaderboardFor(
  state: TableState,
  context: RedactionContext,
): readonly LiveLeaderboardRow[] {
  return liveLeaderboard(state, context);
}

export function sendHandDealt(connection: Connection, payload: HandDealtPayload): void {
  connection.emit(SERVER_EVENTS.handDealt, payload);
}

export function sendActionPrompt(connection: Connection, payload: ActionPromptPayload): void {
  connection.emit(SERVER_EVENTS.actionPrompt, payload);
}

export function sendHandResult(connection: Connection, payload: HandResultPayload): void {
  connection.emit(SERVER_EVENTS.handResult, payload);
}

export function sendTableError(connection: Connection, payload: TableErrorPayload): void {
  connection.emit(SERVER_EVENTS.tableError, payload);
}

export function sendChatMessage(connection: Connection, payload: ChatMessagePayload): void {
  connection.emit(SERVER_EVENTS.chatMessage, payload);
}

/**
 * A reaction, to everybody.
 *
 * It carries no table state — a seat index and a choice from a fixed set — so
 * it needs no redaction. Whether a particular reader wants to see it is their
 * decision and is made on their machine.
 */
export function sendEmote(connection: Connection, payload: EmotePayload): void {
  connection.emit(SERVER_EVENTS.tableEmote, payload);
}

/**
 * The seed behind a hand that has just finished.
 *
 * It carries no cards — it is the 32 bytes the deck was shuffled from, which is
 * only a deck once the hand it belongs to is over. Publishing it is what makes
 * the commitment published before the deal worth anything.
 */
export function sendDeckRevealed(connection: Connection, payload: DeckRevealedPayload): void {
  connection.emit(SERVER_EVENTS.deckRevealed, payload);
}

export function sendSessionReplaced(connection: Connection, message: string): void {
  connection.emit(SERVER_EVENTS.sessionReplaced, { message });
}

/**
 * The one engine event that carries hole cards is HAND_REVEALED, which the
 * engine only emits for hands that were shown down. Anything else carrying
 * cards would be a leak, so it is refused here rather than broadcast.
 */
function assertNoPrivateCards(event: EngineEvent): EngineEvent {
  const type: string = event.type;
  const carriesCards = 'cards' in event;
  const mayCarryCards = type === 'HAND_REVEALED' || type === 'BOARD_DEALT';

  if (carriesCards && !mayCarryCards) {
    throw new Error(`refusing to broadcast ${type}: it carries cards`);
  }
  return event;
}
