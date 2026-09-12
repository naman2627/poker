'use client';

import { create } from 'zustand';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type ActionPromptPayload,
  type ApiError,
  type Card,
  type ChatMessagePayload,
  type HandDealtPayload,
  type HandResultPayload,
  type PlayerActionPayload,
  type PublicTableState,
  type StatePatchPayload,
  type StateSyncPayload,
  type TableConfig,
  type TableEvent,
} from '@poker/shared';
import { announce, type Announcement } from '../announce';
import type { Transport, TransportFrame } from '../net/transport';
import { applyPatch } from './patch';

/**
 * One store, fed by one socket.
 *
 * Every field below arrives from the server. Nothing in this file works out what
 * a legal action is, what a pot is worth or who is winning: the store's whole
 * job is to hold what `state:sync` and `state:patch` said and let React draw it.
 *
 * The single exception, and it is deliberate, is `pending`. When a player clicks
 * Fold the button must go dead in that same frame — waiting for the round trip
 * to disable it is how a nervous player folds twice. So `pending` is set
 * optimistically on click and cleared by the server's acknowledgement. It
 * changes what is *clickable*, never what is *shown*.
 */
export interface TableStoreState {
  readonly status: ConnectionStatus;
  /** How many times the client has tried to get the link back. */
  readonly reconnectAttempt: number;
  readonly transportKind: 'socket' | 'fixture' | null;
  /** The version of the last frame applied; a gap in it triggers a resync. */
  readonly version: number;
  readonly state: PublicTableState | null;
  readonly config: TableConfig | null;
  /** The viewer's own cards, from `hand:dealt`, which no one else receives. */
  readonly holeCards: readonly Card[] | null;
  readonly holeCardsHandId: string | null;
  readonly prompt: ActionPromptPayload | null;
  readonly result: HandResultPayload | null;
  readonly chat: readonly ChatMessagePayload[];
  readonly log: readonly Announcement[];
  /** Chips already paid out this hand; see `potTotal` in ./patch. */
  readonly awarded: number;
  readonly pending: boolean;
  readonly error: ApiError | null;
  readonly notice: string | null;
}

/**
 * The state of the link, as the player is told it.
 *
 * `reconnecting` is its own state and not a flavour of `open`: while it holds,
 * the action bar is dead, because a fold sent into a socket that is not there is
 * a fold the table never hears and a clock that runs out anyway.
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** Whether the table will actually hear an action right now. */
export function isLive(status: ConnectionStatus): boolean {
  return status === 'open';
}

interface TableStoreActions {
  attach(transport: Transport, config: TableConfig | null): void;
  detach(): void;
  /** The table's settings, from the ack to `table:create` or `table:join`. */
  setConfig(config: TableConfig): void;
  /** What to send when a dropped socket comes back, to re-join the table. */
  setRejoin(rejoin: (() => Promise<void>) | null): void;
  send(event: string, payload?: unknown): Promise<boolean>;
  act(action: PlayerActionPayload): Promise<boolean>;
  dismissError(): void;
}

export type TableStore = TableStoreState & TableStoreActions;

const INITIAL: TableStoreState = {
  status: 'idle',
  reconnectAttempt: 0,
  transportKind: null,
  version: -1,
  state: null,
  config: null,
  holeCards: null,
  holeCardsHandId: null,
  prompt: null,
  result: null,
  chat: [],
  log: [],
  awarded: 0,
  pending: false,
  error: null,
  notice: null,
};

/** The hand log is a running commentary, not an archive; the tail is enough. */
const LOG_LIMIT = 60;
const CHAT_LIMIT = 80;

let transport: Transport | null = null;
let unsubscribe: (() => void) | null = null;
let rejoin: (() => Promise<void>) | null = null;
let logSeq = 0;

export const useTableStore = create<TableStore>((set, get) => ({
  ...INITIAL,

  attach(next, config) {
    get().detach();
    transport = next;
    logSeq = 0;
    set({ ...INITIAL, status: 'connecting', transportKind: next.kind, config });
    unsubscribe = next.subscribe((frame) => {
      handleFrame(frame, set, get);
    });
  },

  setConfig(config) {
    set({ config });
  },

  setRejoin(next) {
    rejoin = next;
  },

  detach() {
    unsubscribe?.();
    unsubscribe = null;
    rejoin = null;
    transport?.close();
    transport = null;
    set({ ...INITIAL });
  },

  async send(event, payload) {
    if (!transport) return false;
    const ack = await transport.emit(event, payload);
    if (ack.ok) return true;
    set({ error: ack.error });
    return false;
  },

  /**
   * The one optimistic path: the bar is disabled the instant it is clicked, and
   * stays disabled until the server has answered. A refusal re-enables it and
   * shows why, because the player still has to act.
   */
  async act(action) {
    const store = get();
    if (store.pending) return false;
    // Nothing is sent into a link that is not there. The bar is already disabled
    // in that state; this is the guard behind the guard.
    if (!isLive(store.status)) return false;
    set({ pending: true, error: null });

    const ok = await get().send(CLIENT_EVENTS.playerAction, action);
    if (!ok) set({ pending: false });
    return ok;
  },

  dismissError() {
    set({ error: null });
  },
}));

type SetState = (partial: Partial<TableStoreState>) => void;
type GetState = () => TableStore;

function handleFrame(frame: TransportFrame, set: SetState, get: GetState): void {
  switch (frame.kind) {
    case 'open':
      set({ status: 'open', reconnectAttempt: 0, error: null, notice: null });
      // A socket that has come back knows nothing about which table it was
      // watching, and this client's state is however stale the outage made it.
      // Re-join, then ask for the whole thing rather than trusting a patch to
      // bridge the gap.
      if (frame.reconnected) void recover(get());
      return;

    case 'reconnecting':
      set({
        status: 'reconnecting',
        reconnectAttempt: frame.attempt,
        prompt: null,
        pending: false,
      });
      return;

    case 'closed':
      set({ status: 'closed', prompt: null, pending: false, notice: frame.reason });
      return;

    case 'error':
      set({
        status: 'error',
        error: { code: frame.code as ApiError['code'], message: frame.message },
      });
      return;

    case 'event':
      handleEvent(frame.event, frame.payload, set, get);
      return;
  }
}

function handleEvent(event: string, payload: unknown, set: SetState, get: GetState): void {
  switch (event) {
    case SERVER_EVENTS.stateSync:
      return onSync(payload as StateSyncPayload, set, get);

    case SERVER_EVENTS.statePatch:
      return onPatch(payload as StatePatchPayload, set, get);

    case SERVER_EVENTS.handDealt: {
      const dealt = payload as HandDealtPayload;
      set({ holeCards: dealt.yourCards, holeCardsHandId: dealt.handId });
      return;
    }

    case SERVER_EVENTS.actionPrompt: {
      const prompt = payload as ActionPromptPayload;
      // A fresh prompt is the server's answer to the last action, whoever made
      // it: whatever the bar was waiting for has now happened.
      set({ prompt, pending: false });
      return;
    }

    case SERVER_EVENTS.handResult:
      set({ result: payload as HandResultPayload, prompt: null, pending: false });
      return;

    case SERVER_EVENTS.tableError:
      set({ error: payload as ApiError, pending: false });
      return;

    case SERVER_EVENTS.chatMessage:
      set({ chat: [...get().chat, payload as ChatMessagePayload].slice(-CHAT_LIMIT) });
      return;

    case SERVER_EVENTS.sessionReplaced:
      set({
        status: 'closed',
        notice: (payload as { message?: string }).message ?? 'this table was opened somewhere else',
      });
      return;

    default:
      return;
  }
}

function onSync(payload: StateSyncPayload, set: SetState, get: GetState): void {
  const store = get();

  // Versions only ever go up on a live table, so one that goes down is not an
  // update to what this client is watching — it is a different session (a
  // replaced connection, or the fixture bar's Restart). Everything derived from
  // the old timeline goes with it, rather than a hand log that runs on across a
  // table that has started over.
  if (payload.version < store.version) {
    set({ log: [], chat: [], result: null, holeCards: null, holeCardsHandId: null, error: null });
    logSeq = 0;
  }

  const base: Partial<TableStoreState> = {
    state: payload.state,
    version: payload.version,
    // A whole state supersedes anything pieced together from patches: the pots
    // inside it are the server's own arithmetic, with nothing paid out of them
    // yet as far as this client is concerned.
    awarded: 0,
    status: 'open',
  };

  // Nobody is on the clock, so there is no outstanding prompt to answer.
  set(payload.state.toActSeat === null ? { ...base, prompt: null, pending: false } : base);
}

function onPatch(payload: StatePatchPayload, set: SetState, get: GetState): void {
  const store = get();
  const events = payload.events;

  // The log and the live region are driven by every patch, even one whose state
  // has already been applied — what happened is worth saying exactly once, and
  // the events are the only place it is said.
  const log = appendLog(store.log, events, store.state);

  if (store.state === null) {
    set({ log });
    void resync(store, 0);
    return;
  }

  // A full `state:sync` and the patch describing the same change carry the same
  // version, and the server sends the sync first. Re-applying the patch on top
  // would be double-counting, so at an equal version the events are commentary
  // only.
  if (payload.version <= store.version) {
    set({ log });
    return;
  }

  if (payload.version > store.version + 1) {
    // A frame went missing. Rather than draw a table with a hole in it, ask for
    // the whole thing.
    set({ log });
    void resync(store, store.version);
    return;
  }

  const applied = applyPatch(store.state, store.awarded, events);

  // The live board is the server's, whenever the server sent one — which a real
  // server always does. `applyPatch` only keeps the stacks moving for the
  // recorded hand, which has no server behind it.
  const state =
    payload.leaderboard === undefined
      ? applied.state
      : { ...applied.state, leaderboard: [...payload.leaderboard] };

  set({ state, awarded: applied.awarded, version: payload.version, log });

  // Pot *layers* are the server's arithmetic and only ride along with a whole
  // state. Streets are exactly when they change, so a street change is where
  // the client asks for them again — once per street, not once per action.
  if (applied.resyncNeeded || applied.phaseChanged) void resync(store, payload.version);
}

function appendLog(
  log: readonly Announcement[],
  events: readonly TableEvent[],
  state: PublicTableState | null,
): Announcement[] {
  const added: Announcement[] = [];

  for (const event of events) {
    logSeq += 1;
    const line = announce(event, state, `log-${String(logSeq)}`);
    if (line) added.push(line);
  }

  return [...log, ...added].slice(-LOG_LIMIT);
}

async function resync(store: TableStore, fromVersion: number): Promise<void> {
  await store.send(CLIENT_EVENTS.stateResync, { fromVersion });
}

/**
 * Put a reconnected socket back where it was.
 *
 * The order matters: re-join first, because a fresh socket is not at any table
 * and a resync would be answered with nothing. Then take the whole state, since
 * whatever happened while the link was down cannot be pieced together from
 * patches that were never delivered.
 */
async function recover(store: TableStore): Promise<void> {
  if (rejoin) await rejoin();
  await resync(store, Math.max(0, store.version));
}
