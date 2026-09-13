import { randomUUID } from 'node:crypto';
import {
  createSeedRng,
  createTable,
  legalActions,
  reduce,
  totalPot,
  type Command,
  type EngineEvent,
  type HandCategory,
  type LegalActions,
  type PlayerActionInput,
  type Pot,
  type Rng,
  type TableState,
} from '@poker/engine';
import {
  EMOTE_COOLDOWN_MS,
  type Emote,
  type PlayerActionPayload,
  type TableConfig,
} from '@poker/shared';
import type { HistoryRecorder } from '../history/recorder';
import type { StatsRecorder } from '../stats/recorder';
import { cardCodes, type CardCode, type HandEnded, type Street } from '../history/records';
import { commitTo, newDeckSeed } from '../history/verify';
import {
  leaderboardFor,
  sendActionPrompt,
  sendChatMessage,
  sendDeckRevealed,
  sendEmote,
  sendHandDealt,
  sendHandResult,
  sendSessionReplaced,
  sendStatePatch,
  sendStateSync,
  type Connection,
} from './broadcast';
import { TableError } from './errors';
import { seatIndexOf, type LiveSession, type MemberProfile, type RedactionContext } from './redact';

/**
 * One sitting, as the table counts it.
 *
 * The same three numbers `redact.ts` reads, with the `readonly` taken off:
 * this is the side that does the counting, and the map it lives in is handed
 * to `redactFor` as a `ReadonlyMap` so nothing downstream can move them.
 */
type Sitting = { -readonly [K in keyof LiveSession]: LiveSession[K] };

/** Time and timers, injected so a test can run a thirty-second clock in a millisecond. */
export interface Scheduler {
  now(): number;
  /** Runs `callback` after `delayMs`; the returned function cancels it. */
  schedule(callback: () => void, delayMs: number): () => void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    // A pending action timer must never be the reason the process stays alive.
    timer.unref?.();
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * The pauses a table takes on its own.
 *
 * `showdownBeatMs` is the moment between the cards going face up and the chips
 * moving. It is the server's pause, not an animation: everyone at the table gets
 * the same two seconds, and a client that renders instantly still cannot see the
 * pot move before the hands are shown.
 *
 * `dealDelayMs` is the gap before a hand is dealt. It is what stops four people
 * who sat down together being split across two hands because two of them
 * finished clicking first, and it doubles as the pause to read the last result.
 */
export interface TableTimings {
  readonly showdownBeatMs: number;
  readonly dealDelayMs: number;
}

export const DEFAULT_TIMINGS: TableTimings = {
  showdownBeatMs: 2_000,
  dealDelayMs: 2_500,
};

/**
 * The cooldown lives in @poker/shared so the client can grey its buttons out
 * for the right length of time — but it is enforced *here*, against this
 * table's clock. A cooldown a client owns is a cooldown that does not exist
 * (CLAUDE.md §4).
 */
export { EMOTE_COOLDOWN_MS };

export interface TableRuntimeOptions {
  readonly code: string;
  readonly config: TableConfig;
  readonly rng: Rng;
  readonly scheduler?: Scheduler;
  readonly timings?: TableTimings;
  /** Whoever created the table. The only account that may pause it. */
  readonly hostUserId?: string | null;
  /** Where the record of play goes. Absent means it is not kept. */
  readonly history?: HistoryRecorder | null;
  /**
   * Where the lifetime counters go. Absent means no global board is kept — the
   * live board is derived from this runtime's own memory and needs nothing.
   */
  readonly stats?: StatsRecorder | null;
  /**
   * Where each hand's deck seed comes from. Production draws 32 random bytes;
   * a test hands over a fixed sequence so the cards are the same every run.
   */
  readonly deckSeeds?: () => string;
}

/** Phases where the next thing to do is deal, not wait for a player or a clock. */
const ADVANCEABLE = new Set(['preflop', 'flop', 'turn', 'river', 'payout']);

/**
 * One table, live.
 *
 * It owns exactly three things: a `TableState`, a queue that keeps every change
 * to it single-file, and the clocks. Every mutation goes through `#enqueue`, so
 * two sockets arriving in the same tick are still applied one after the other,
 * and every change ends in one broadcast with one new version.
 *
 * The poker rules are not here. This file decides *when* to call the engine and
 * *who* hears about it; what a fold means lives in @poker/engine.
 */
export class TableRuntime {
  readonly code: string;
  readonly config: TableConfig;
  readonly hostUserId: string | null;

  #state: TableState;
  readonly #rng: Rng;
  readonly #scheduler: Scheduler;
  readonly #timings: TableTimings;

  /** One socket per user: a second connection replaces the first. */
  readonly #connections = new Map<string, Connection>();
  readonly #members = new Map<string, MemberProfile>();

  /**
   * The cards this table has turned face up, and the ones it has not.
   *
   * `redactFor` reads `#revealed` and nothing else, so a hand that mucked stays
   * private however far the phase moves. Both are cleared when a hand starts.
   */
  readonly #revealed = new Set<number>();
  readonly #mucked = new Set<number>();
  /**
   * The made hand behind each seat the showdown turned face up.
   *
   * Only what the table actually saw, which is what the lifetime "best hand"
   * statistic is allowed to count — a mucked hand stays its owner's (CLAUDE.md
   * §1). A player who chooses to show a mucked hand afterwards does so after
   * the hand has already been counted, so that is a reveal to the table rather
   * than to the record.
   */
  readonly #shownCategories = new Map<number, HandCategory>();
  /** What was shown, and in what order, kept so `hand:result` can repeat it. */
  #showdown: {
    revealed: {
      seatIndex: number;
      cards: { rank: number; suit: 's' | 'h' | 'd' | 'c' }[];
      handName: string;
      order: number;
    }[];
    mucked: { seatIndex: number; order: number }[];
  } = { revealed: [], mucked: [] };

  readonly #history: HistoryRecorder | null;
  readonly #stats: StatsRecorder | null;
  readonly #deckSeeds: () => string;

  /**
   * The LIVE board's raw material: what each seated player has done since they
   * sat down.
   *
   * Memory only, and that is the point — nothing here is ever written anywhere,
   * and standing up ends the count. `boughtIn` starts at the buy-in and grows
   * with every rebuy, which is what makes `net` mean "up or down for this
   * sitting". `redact.ts` turns this into rows; see `liveLeaderboard`.
   */
  readonly #sessions = new Map<string, Sitting>();
  /** When each player last reacted, for the cooldown above. */
  readonly #lastEmoteAt = new Map<string, number>();

  /**
   * This hand's shuffle, and the promise made about it.
   *
   * The seed is drawn before the deal and the commitment goes out with the first
   * whole state of the hand. The seed itself stays here until the hand is over —
   * it is the deck, and publishing it early would publish everybody's cards.
   */
  #deckSeed: string | null = null;
  #deckCommit: string | null = null;
  #handStartedAt = 0;
  #actionCount = 0;
  #potSoFar = 0;
  #committedThisRound = new Map<number, number>();
  #street: Street = 'preflop';
  /** Stacks as the hand began, for `net` when it ends. */
  #startingStacks = new Map<number, number>();

  #paused = false;
  #version = 0;
  /** How many actions have been taken in the current hand. */
  #actionSeq = 0;
  #deadlineTs: number | null = null;
  #cancelTimer: (() => void) | null = null;
  #cancelBeat: (() => void) | null = null;
  #cancelDeal: (() => void) | null = null;
  #potsAtPayout: readonly Pot[] = [];
  /** The seats as the pot was pushed, before anybody leaving is cleared out. */
  #seatsAtPayout: readonly TableState['seats'][number][] = [];
  #wonThisHand = new Map<number, number>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: TableRuntimeOptions) {
    this.code = options.code;
    this.config = options.config;
    this.hostUserId = options.hostUserId ?? null;
    this.#rng = options.rng;
    this.#scheduler = options.scheduler ?? systemScheduler;
    this.#timings = options.timings ?? DEFAULT_TIMINGS;
    this.#history = options.history ?? null;
    this.#stats = options.stats ?? null;
    this.#deckSeeds = options.deckSeeds ?? newDeckSeed;
    this.#state = createTable({
      seatCount: options.config.seatCount,
      smallBlind: options.config.smallBlind,
      bigBlind: options.config.bigBlind,
    });
  }

  get version(): number {
    return this.#version;
  }

  get handId(): string | null {
    return this.#state.handId;
  }

  get actionSeq(): number {
    return this.#actionSeq;
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** A copy of the state for tests and for the runtime's own callers. Server-side only. */
  get state(): TableState {
    return this.#state;
  }

  get memberCount(): number {
    return this.#connections.size;
  }

  /* ---------------------------------------------------------------- *
   * Connections                                                      *
   * ---------------------------------------------------------------- */

  /**
   * A socket joins the table.
   *
   * Whoever was here under the same user id is told why they are being replaced
   * and dropped, so a player cannot watch their own table twice and see two
   * different versions of it.
   */
  attach(connection: Connection, profile: MemberProfile): Promise<void> {
    return this.#enqueue(() => {
      const existing = this.#connections.get(connection.userId);
      if (existing && existing.socketId !== connection.socketId) {
        sendSessionReplaced(existing, 'this table was opened somewhere else');
        existing.disconnect();
      }

      this.#connections.set(connection.userId, connection);
      this.#members.set(connection.userId, profile);

      sendStateSync(connection, this.#version, this.#state, this.#context());
      this.#sendPrivateCards(connection);
      this.#promptIfWaiting(connection);
    });
  }

  /**
   * A socket went away.
   *
   * The seat stays: leaving the table is a separate act, and a player whose
   * train went into a tunnel should find their chips where they left them. The
   * action clock keeps running, so a disconnected player still folds or checks
   * when their time is up rather than holding the table forever.
   */
  detach(socketId: string): void {
    for (const [userId, connection] of this.#connections) {
      if (connection.socketId === socketId) this.#connections.delete(userId);
    }
  }

  /** Full state, on request. A resync is always the whole truth, never a patch. */
  resync(userId: string): Promise<void> {
    return this.#enqueue(() => {
      const connection = this.#connections.get(userId);
      if (!connection) return;
      sendStateSync(connection, this.#version, this.#state, this.#context());
      this.#sendPrivateCards(connection);
      this.#promptIfWaiting(connection);
    });
  }

  /* ---------------------------------------------------------------- *
   * Table membership                                                 *
   * ---------------------------------------------------------------- */

  /**
   * Take a seat.
   *
   * A player who sits down is dealt out until they say they are in. Sitting is
   * choosing a chair; joining the game is a second, deliberate act, and pushing
   * somebody into a hand the moment they sat is how a player posts a blind they
   * never meant to.
   */
  sit(userId: string, seatIndex: number, buyIn: number): Promise<void> {
    return this.#enqueue(() => {
      if (seatIndex < 0 || seatIndex >= this.#state.seats.length) {
        throw TableError.invalidInput(`seat ${String(seatIndex)} is not a seat at this table`);
      }
      if (this.#state.seats[seatIndex]) {
        throw TableError.conflict('somebody is already in that seat');
      }
      if (seatIndexOf(this.#state, userId) !== null) {
        throw TableError.conflict('you are already sitting at this table');
      }
      if (buyIn < this.config.minBuyIn || buyIn > this.config.maxBuyIn) {
        throw TableError.invalidInput(
          `the buy-in must be between ${String(this.config.minBuyIn)} and ${String(this.config.maxBuyIn)}`,
        );
      }

      // A new sitting: the live board counts from here, and whatever this
      // player did in a previous stretch at this table is finished with.
      this.#sessions.set(userId, { boughtIn: buyIn, handsWon: 0, biggestPot: 0 });

      this.#publish(
        [
          ...this.#run({ type: 'SIT', seatIndex, playerId: userId, stack: buyIn }),
          ...this.#run({ type: 'SET_SITTING_OUT', seatIndex, sittingOut: true }),
        ],
        { fullSync: true },
      );

      this.#history?.record({
        kind: 'session-started',
        code: this.code,
        userId,
        displayName: this.#members.get(userId)?.displayName ?? '',
        seatIndex,
        buyIn,
        at: new Date(this.#scheduler.now()),
      });
    });
  }

  leave(userId: string): Promise<void> {
    return this.#enqueue(() => {
      const seatIndex = seatIndexOf(this.#state, userId);
      if (seatIndex === null) return;

      // Read the stack before the command, because a seat that leaves between
      // hands is gone by the time it has been applied.
      const cashOut = this.#state.seats[seatIndex]?.stack ?? 0;
      this.#dispatch({ type: 'LEAVE', seatIndex }, { fullSync: true });

      // A player leaving mid-hand keeps their seat until the hand is paid out,
      // so their row stays on the live board until it really is gone. `#prune`
      // at the end of a hand clears up whatever is left.
      if (seatIndexOf(this.#state, userId) === null) {
        this.#sessions.delete(userId);
        this.#lastEmoteAt.delete(userId);
      }

      this.#history?.record({
        kind: 'session-ended',
        code: this.code,
        userId,
        cashOut,
        at: new Date(this.#scheduler.now()),
      });
    });
  }

  /**
   * "Deal me in", and "deal me out".
   *
   * Readiness is this flag and nothing else: once a player is in, they stay in
   * hand after hand until they say otherwise, which is what lets a table play
   * twenty hands without twenty rounds of clicking.
   */
  setSittingOut(userId: string, sittingOut: boolean): Promise<void> {
    return this.#enqueue(() => {
      const seatIndex = this.#requireSeat(userId);

      this.#publish(this.#run({ type: 'SET_SITTING_OUT', seatIndex, sittingOut }), {
        fullSync: true,
      });
    });
  }

  /** Kept for the client's `player:ready`, which means exactly "deal me in". */
  ready(userId: string): Promise<void> {
    return this.setSittingOut(userId, false);
  }

  /**
   * More chips, between hands.
   *
   * The cap is the table's maximum buy-in: a rebuy tops a stack up to it, and
   * one that would take a seat past it is refused rather than trimmed, so a
   * player who asked for 1000 never finds they bought 400.
   */
  rebuy(userId: string, amount: number): Promise<void> {
    return this.#enqueue(() => {
      const seatIndex = this.#requireSeat(userId);
      const seat = this.#state.seats[seatIndex];
      if (!seat) throw TableError.forbidden('you are not sitting at this table');

      if (seat.status !== 'sitting_out' && this.#handInProgress()) {
        throw TableError.invalidAction('you can only rebuy between hands');
      }
      if (seat.stack + amount > this.config.maxBuyIn) {
        throw TableError.invalidInput(
          `that would put you over the table maximum of ${String(this.config.maxBuyIn)}`,
        );
      }

      const session = this.#sessions.get(userId);
      if (session) session.boughtIn += amount;

      this.#dispatch({ type: 'REBUY', seatIndex, amount }, { fullSync: true });
    });
  }

  /**
   * Show a hand that was mucked.
   *
   * Only the owner may ask, only for the hand they were just in, and only for a
   * hand that actually reached a showdown and did not have to be shown. The
   * cards do not travel in the reply: the seat joins `#revealed` and the next
   * whole state carries them, through `redactFor` like everything else.
   */
  show(userId: string, handId: string): Promise<void> {
    return this.#enqueue(() => {
      const seatIndex = this.#requireSeat(userId);
      if (this.#state.handId !== handId) {
        throw TableError.invalidAction('that hand is over');
      }
      if (!this.#mucked.has(seatIndex)) {
        throw TableError.invalidAction('there is nothing of yours left to show');
      }

      this.#mucked.delete(seatIndex);
      this.#revealed.add(seatIndex);
      this.#publish([], { fullSync: true });
    });
  }

  /**
   * The host stopping the deal.
   *
   * A pause never interrupts a hand — the one in progress plays out to its
   * payout, because chips are already in the middle and stopping there would
   * leave them nowhere. It stops the *next* hand from starting.
   */
  pause(userId: string, paused: boolean): Promise<void> {
    return this.#enqueue(() => {
      if (this.hostUserId !== null && userId !== this.hostUserId) {
        throw TableError.forbidden('only the host can pause this table');
      }
      if (this.#paused === paused) return;

      this.#paused = paused;
      if (paused) this.#cancelDealTimer();

      this.#publish([], { fullSync: true });
    });
  }

  chat(userId: string, text: string): void {
    const profile = this.#members.get(userId);
    const payload = {
      userId,
      displayName: profile?.displayName ?? '',
      text,
      at: this.#scheduler.now(),
    };
    for (const connection of this.#connections.values()) sendChatMessage(connection, payload);
  }

  /**
   * A reaction, from somebody sitting at the table.
   *
   * Two refusals, and both are the server's to make:
   *
   *   you have to be in a seat. A reaction floats over a chair, so somebody
   *   watching from the rail has no chair to float it over — and a table where
   *   spectators can react is a table anyone can interrupt.
   *
   *   you have to have waited. The cooldown is measured here against this
   *   table's clock; a client that asks early is told no rather than trusted.
   *
   * It changes no table state, so it does not go through `#publish`: nothing
   * about the hand has moved, and bumping the version for a reaction would make
   * every client re-check its state because somebody laughed.
   */
  emote(userId: string, emote: Emote): Promise<void> {
    return this.#enqueue(() => {
      const seatIndex = this.#requireSeat(userId);

      const now = this.#scheduler.now();
      const last = this.#lastEmoteAt.get(userId);
      if (last !== undefined && now - last < EMOTE_COOLDOWN_MS) {
        const waitSec = Math.ceil((EMOTE_COOLDOWN_MS - (now - last)) / 1000);
        throw TableError.rateLimited(`give it ${String(waitSec)}s`);
      }
      this.#lastEmoteAt.set(userId, now);

      const payload = { userId, seatIndex, emote, at: now };
      for (const connection of this.#connections.values()) sendEmote(connection, payload);
    });
  }

  /* ---------------------------------------------------------------- *
   * Play                                                             *
   * ---------------------------------------------------------------- */

  /**
   * A player acts.
   *
   * Everything is checked against the state the server holds: the hand, the
   * position in it, whose turn it is, and — for a bet or a raise — the exact
   * range the engine says is legal. An amount outside that range is refused
   * with the range in the message. It is never quietly moved to the nearest
   * legal number, because a client that thought it was betting 300 should not
   * find out later that it bet 1000.
   */
  playerAction(userId: string, payload: PlayerActionPayload): Promise<void> {
    return this.#enqueue(() => {
      const state = this.#state;
      const seatIndex = seatIndexOf(state, userId);
      if (seatIndex === null) throw TableError.forbidden('you are not sitting at this table');

      if (state.handId === null || state.handId !== payload.handId) {
        throw TableError.invalidAction('that hand is over');
      }
      if (payload.actionSeq !== this.#actionSeq) {
        throw TableError.invalidAction('that action is out of date — resync and try again');
      }
      if (state.toActSeat !== seatIndex) {
        throw TableError.invalidAction('it is not your turn');
      }

      const legal = legalActions(state, seatIndex);
      const action = this.#toEngineAction(payload, legal, state, seatIndex);

      this.#actionSeq += 1;
      this.#dispatch({ type: 'PLAYER_ACTION', seatIndex, action }, { fullSync: false });
    });
  }

  /** Time ran out. Checking is free or it is a fold; the engine decides which. */
  #timeout(seatIndex: number, handId: string): Promise<void> {
    return this.#enqueue(() => {
      const state = this.#state;
      if (state.handId !== handId || state.toActSeat !== seatIndex) return;

      this.#actionSeq += 1;
      this.#dispatch(
        { type: 'TIMEOUT', seatIndex, now: this.#scheduler.now() },
        { fullSync: false },
      );
    });
  }

  /** Resolves once every queued change has been applied and broadcast. */
  whenIdle(): Promise<void> {
    return this.#queue.then(
      () => undefined,
      () => undefined,
    );
  }

  /** Stops every clock. Called when the table is torn down. */
  close(): void {
    this.#closed = true;
    this.#clearTimer();
    this.#cancelBeatTimer();
    this.#cancelDealTimer();
  }

  /* ---------------------------------------------------------------- *
   * The engine, and everything after it                              *
   * ---------------------------------------------------------------- */

  /**
   * The single path from a command to the sockets: reduce, deal out whatever
   * follows on its own, then broadcast once with one new version.
   */
  #dispatch(command: Command, options: { fullSync: boolean }): void {
    const events = this.#run(command);
    events.push(...this.#autoAdvance());
    this.#publish(events, options);
  }

  /**
   * One command through the engine.
   *
   * `rng` is overridden for exactly one command — START_HAND, with the seed this
   * hand committed to — because that is the only command that shuffles.
   * Everything else takes the table's own source, which nothing reads.
   */
  #run(command: Command, rng: Rng = this.#rng): EngineEvent[] {
    const before = this.#state;
    const result = reduce(before, command, rng);
    this.#state = result.state;

    // The pots and the seats as they stood when the showdown was resolved.
    // `hand:result` reports what was played for, and by then the engine has
    // emptied the pots; the record needs the seats before `endHand` vacates
    // anybody who was on their way out.
    if (before.phase !== 'payout' && this.#state.phase === 'payout') {
      this.#potsAtPayout = before.pots;
      this.#seatsAtPayout = this.#state.seats;
    }

    for (const event of result.events) this.#noteEvent(event);
    return [...result.events];
  }

  /**
   * Keep the face-up set in step with what the engine turned over.
   *
   * This is the only thing that puts a seat into `#revealed` automatically, and
   * a new hand empties both sets — so last hand's cards cannot survive into a
   * state where they would be shown alongside this hand's.
   */
  #noteEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'HAND_STARTED':
        this.#revealed.clear();
        this.#mucked.clear();
        this.#shownCategories.clear();
        this.#wonThisHand.clear();
        this.#showdown = { revealed: [], mucked: [] };
        return;

      case 'HAND_REVEALED':
        this.#revealed.add(event.seatIndex);
        this.#shownCategories.set(event.seatIndex, event.category);
        this.#showdown.revealed.push({
          seatIndex: event.seatIndex,
          cards: event.cards.map((card) => ({ rank: card.rank, suit: card.suit })),
          handName: event.handName,
          order: event.order,
        });
        this.#recordAction(event.seatIndex, 'SHOW', 0);
        return;

      case 'HAND_MUCKED':
        this.#mucked.add(event.seatIndex);
        this.#showdown.mucked.push({ seatIndex: event.seatIndex, order: event.order });
        this.#recordAction(event.seatIndex, 'MUCK', 0);
        return;

      case 'BLIND_POSTED':
        this.#commitTo(event.seatIndex, event.amount);
        this.#recordAction(
          event.seatIndex,
          event.blind === 'small' ? 'POST_SMALL_BLIND' : 'POST_BIG_BLIND',
          event.amount,
        );
        return;

      case 'PLAYER_ACTED':
        this.#commitTo(event.seatIndex, event.committedThisRound);
        this.#recordAction(event.seatIndex, event.action, event.committedThisRound);
        return;

      case 'ACTION_TIMED_OUT':
        this.#recordAction(
          event.seatIndex,
          event.appliedAction === 'FOLD' ? 'TIMEOUT_FOLD' : 'TIMEOUT_CHECK',
          0,
        );
        return;

      case 'BOARD_DEALT':
        // A new street: what everybody has in front of them goes into the
        // middle, and the per-street totals start again from nothing.
        this.#street = event.phase;
        this.#committedThisRound.clear();
        this.#recordAction(null, 'DEAL', 0);
        return;

      case 'SHOWDOWN_REACHED':
        this.#street = 'showdown';
        this.#committedThisRound.clear();
        return;

      case 'POT_AWARDED':
        this.#street = 'payout';
        this.#wonThisHand.set(
          event.seatIndex,
          (this.#wonThisHand.get(event.seatIndex) ?? 0) + event.amount,
        );
        this.#recordAction(event.seatIndex, 'WIN', event.amount);
        return;

      case 'HAND_ENDED':
        this.#closeOutSessions();
        this.#recordHandEnded();
        return;

      default:
        return;
    }
  }

  /**
   * Chips moving, as the record counts them.
   *
   * Events carry a seat's total for the *street*, so the pot grows by the
   * difference. The same arithmetic the client does, for the same reason: it is
   * the only way to turn "seat 3 is now in for 150" into "the pot is now 430".
   */
  #commitTo(seatIndex: number, committedThisRound: number): void {
    const before = this.#committedThisRound.get(seatIndex) ?? 0;
    this.#potSoFar += Math.max(0, committedThisRound - before);
    this.#committedThisRound.set(seatIndex, committedThisRound);
  }

  /** One step of a replay. Never carries a card — see `history/records.ts`. */
  #recordAction(seatIndex: number | null, action: string, amount: number): void {
    const handId = this.#state.handId;
    if (this.#history === null || handId === null) return;

    const userId =
      seatIndex === null
        ? null
        : (this.#state.seats[seatIndex]?.playerId ??
          this.#seatsAtPayout[seatIndex]?.playerId ??
          null);

    this.#actionCount += 1;
    this.#history.record({
      kind: 'hand-action',
      handId,
      seq: this.#actionCount,
      userId,
      street: this.#street,
      action,
      amount,
      potAfter: this.#potSoFar,
      elapsedMs: Math.max(0, this.#scheduler.now() - this.#handStartedAt),
    });
  }

  /**
   * Cards come out on their own.
   *
   * Once nobody has an action left, the next street is not a decision anybody
   * makes — the server deals it immediately and the client animates from the
   * events. A hand that ends in folds cascades all the way to `hand_end` inside
   * one dispatch, so the table is never left half-settled.
   *
   * `showdown` is the deliberate exception: it stops here, and `#armBeat`
   * restarts it after the pause. That is the beat between the hands going face
   * up and the pot moving.
   */
  #autoAdvance(): EngineEvent[] {
    const collected: EngineEvent[] = [];

    for (let guard = 0; guard < 32; guard += 1) {
      const state = this.#state;
      if (state.toActSeat !== null || !ADVANCEABLE.has(state.phase)) break;
      collected.push(...this.#run({ type: 'ADVANCE_STREET' }));
    }

    return collected;
  }

  #publish(events: readonly EngineEvent[], options: { fullSync: boolean }): void {
    if (this.#closed) return;

    this.#version += 1;
    const context = this.#context();
    // Recomputed once per publish — which is once per change to the table, and
    // so once per stack movement — and sent to everybody. It is the same board
    // for every viewer, so there is nothing per-socket to build.
    const leaderboard = leaderboardFor(this.#state, context);

    for (const connection of this.#connections.values()) {
      if (options.fullSync) {
        sendStateSync(connection, this.#version, this.#state, context);
      }
      if (events.length > 0) {
        sendStatePatch(connection, this.#version, events, leaderboard);
      }
    }

    if (events.some((event) => event.type === 'POT_AWARDED')) this.#sendHandResult(events);
    if (events.some((event) => event.type === 'HOLE_CARDS_DEALT')) {
      for (const connection of this.#connections.values()) this.#sendPrivateCards(connection);
    }

    this.#armTimer();
    this.#armBeat();
    this.#armDeal();
  }

  #sendHandResult(events: readonly EngineEvent[]): void {
    const handId = this.#state.handId ?? '';
    const awards = events
      .filter((event) => event.type === 'POT_AWARDED')
      .map((event) => ({
        seatIndex: event.seatIndex,
        amount: event.amount,
        potIndex: event.potIndex,
      }));

    // The reveals went out a phase earlier, with the showdown. What is repeated
    // here is what the table showed, in the order it showed it — and who mucked,
    // which is how a client knows whose Show button to offer.
    const payload = {
      handId,
      pots: this.#potsAtPayout.map((pot) => ({
        amount: pot.amount,
        eligibleSeats: [...pot.eligibleSeats],
      })),
      awards,
      revealed: [...this.#showdown.revealed].sort((a, b) => a.order - b.order),
      mucked: this.#showdown.mucked.filter((muck) => this.#mucked.has(muck.seatIndex)),
    };

    for (const connection of this.#connections.values()) sendHandResult(connection, payload);
  }

  /**
   * Can a hand be dealt right now?
   *
   * "In" is the sitting-out flag, not a per-hand acknowledgement: a player who
   * said they were in stays in until they say otherwise, so a table deals hand
   * after hand on its own. A paused table deals none.
   */
  #canDeal(): boolean {
    const state = this.#state;
    if (this.#closed || this.#paused) return false;
    if (state.phase !== 'waiting' && state.phase !== 'hand_end') return false;

    const dealable = state.seats.filter(
      (seat) => seat !== null && seat.stack > 0 && !seat.sittingOut,
    );
    return dealable.length >= 2;
  }

  /**
   * Deal a hand from a deck nobody can argue with afterwards.
   *
   * Thirty-two bytes are drawn, `sha256` of them becomes this hand's public
   * commitment, and the shuffle comes from the bytes themselves. The commitment
   * goes out with the state that starts the hand — before a single card — and
   * the seed stays here until the hand is over.
   *
   * That ordering is the whole guarantee. Having committed, the server cannot
   * change what it deals; not having published the seed, it has told nobody what
   * that is. `GET /hands/:id/verify` re-runs both halves.
   */
  #startHand(): void {
    if (!this.#canDeal()) return;

    const handId = randomUUID();
    const seed = this.#deckSeeds();
    this.#deckSeed = seed;
    this.#deckCommit = commitTo(seed);
    this.#handStartedAt = this.#scheduler.now();
    this.#actionCount = 0;
    this.#potSoFar = 0;
    this.#street = 'preflop';
    this.#committedThisRound.clear();
    this.#startingStacks = new Map(
      this.#state.seats.filter((seat) => seat !== null).map((seat) => [seat.seatIndex, seat.stack]),
    );

    this.#actionSeq = 0;

    // The deck is this seed's, and nothing else's: only START_HAND shuffles, so
    // this one call fixes every card in the hand.
    const started = this.#run({ type: 'START_HAND', handId }, createSeedRng(seed));

    // Before the blinds, because the blinds are actions and an action cannot be
    // recorded before the hand it belongs to. START_HAND is what assigns the
    // button and the dealt-in seats, so this is the first moment there is a hand
    // to describe.
    this.#recordHandStarted(handId);

    this.#publish(
      [
        ...started,
        ...this.#run({ type: 'POST_BLINDS' }),
        ...this.#run({ type: 'DEAL_HOLE' }),
        ...this.#autoAdvance(),
      ],
      { fullSync: true },
    );
  }

  #recordHandStarted(handId: string): void {
    const state = this.#state;
    const commit = this.#deckCommit;
    if (this.#history === null || commit === null) return;

    this.#history.record({
      kind: 'hand-started',
      code: this.code,
      handId,
      handNumber: state.handNumber,
      buttonSeat: state.buttonSeat ?? 0,
      smallBlind: state.smallBlind,
      bigBlind: state.bigBlind,
      deckCommit: commit,
      at: new Date(this.#handStartedAt),
      players: state.dealtInSeats.flatMap((seatIndex) => {
        const seat = state.seats[seatIndex];
        if (!seat) return [];
        return [
          {
            userId: seat.playerId,
            displayName: this.#members.get(seat.playerId)?.displayName ?? '',
            seatIndex,
            startingStack: this.#startingStacks.get(seatIndex) ?? seat.stack,
          },
        ];
      }),
    });
  }

  /**
   * The end of a hand: publish the seed, and hand the record over.
   *
   * Everything a finished hand reveals goes out together — the seed to the
   * table, and the seed plus every seat's cards to the recorder, which writes
   * them in one transaction alongside `ended_at`.
   */
  #recordHandEnded(): void {
    const state = this.#state;
    const seed = this.#deckSeed;
    const commit = this.#deckCommit;
    const handId = state.handId;
    if (seed === null || commit === null || handId === null) return;

    for (const connection of this.#connections.values()) {
      sendDeckRevealed(connection, { handId, deckCommit: commit, deckSeed: seed });
    }

    // The seats as the pot was pushed. Anybody who was standing up has been
    // cleared out of `state.seats` by now, and their hand is still part of the
    // record.
    const players = state.dealtInSeats.flatMap((seatIndex) => {
      const seat = this.#seatsAtPayout[seatIndex] ?? state.seats[seatIndex];
      if (!seat) return [];

      const startingStack = this.#startingStacks.get(seatIndex) ?? seat.stack;
      const dealt: CardCode[] = cardCodes(seat.holeCards);
      const shown = this.#revealed.has(seatIndex);

      return [
        {
          userId: seat.playerId,
          seatIndex,
          holeCards: dealt,
          shown,
          endingStack: seat.stack,
          net: seat.stack - startingStack,
          // Everything this seat put in this hand. The pot was built out of
          // these, so they are already the right number — nothing is re-derived.
          wagered: seat.committedThisHand,
          potWon: this.#wonThisHand.get(seatIndex) ?? 0,
          // Only a hand the table actually saw. See `#shownCategories`.
          shownCategory: shown ? (this.#shownCategories.get(seatIndex) ?? null) : null,
          wentToShowdown: shown || this.#mucked.has(seatIndex),
          won: (this.#wonThisHand.get(seatIndex) ?? 0) > 0,
        },
      ];
    });

    const record: HandEnded = {
      kind: 'hand-ended',
      handId,
      board: cardCodes(state.board),
      totalPot: totalPot(this.#potsAtPayout),
      deckSeed: seed,
      bigBlind: state.bigBlind,
      at: new Date(this.#scheduler.now()),
      players,
    };

    // Two consumers, two queues, one record. The history writes the hand down;
    // the statistics count it. Neither can make the table wait, and a failure
    // in one does not touch the other — see `stats/recorder.ts` for why the
    // retry rules cannot be shared.
    this.#history?.record(record);
    this.#stats?.record(record);

    this.#deckSeed = null;
  }

  /**
   * The live board, at the end of a hand.
   *
   * A hand won is counted once however many pots it took, and the biggest pot
   * is the most chips taken out of the middle in a single hand — both per
   * sitting, both in memory, both gone when the player stands up.
   *
   * This runs before `#recordHandEnded` queues anything, so the board that goes
   * out with `HAND_ENDED` already has the hand in it.
   */
  #closeOutSessions(): void {
    const state = this.#state;

    for (const [seatIndex, amount] of this.#wonThisHand) {
      if (amount <= 0) continue;

      const playerId = this.#seatsAtPayout[seatIndex]?.playerId ?? state.seats[seatIndex]?.playerId;
      if (playerId === undefined) continue;

      const session = this.#sessions.get(playerId);
      if (!session) continue;

      session.handsWon += 1;
      session.biggestPot = Math.max(session.biggestPot, amount);
    }

    // Anybody whose seat has now emptied — they asked to leave mid-hand and the
    // payout let them go. Their sitting is over, so their row goes with it.
    const seated = new Set(
      state.seats.filter((seat) => seat !== null).map((seat) => seat.playerId),
    );
    for (const userId of [...this.#sessions.keys()]) {
      if (!seated.has(userId)) this.#sessions.delete(userId);
    }
  }

  /**
   * The hand a viewer is holding, to that viewer alone.
   *
   * This is the only payload in the system that is different per socket, and it
   * never goes anywhere but the one socket that owns the cards.
   */
  #sendPrivateCards(connection: Connection): void {
    const state = this.#state;
    const seatIndex = seatIndexOf(state, connection.userId);
    if (seatIndex === null || state.handId === null) return;

    const seat = state.seats[seatIndex];
    if (!seat || seat.holeCards.length === 0) return;

    sendHandDealt(connection, {
      handId: state.handId,
      seatIndex,
      yourCards: seat.holeCards.map((card) => ({ rank: card.rank, suit: card.suit })),
    });
  }

  #promptIfWaiting(connection: Connection): void {
    const prompt = this.#currentPrompt();
    if (prompt) sendActionPrompt(connection, prompt);
  }

  #currentPrompt(): {
    handId: string;
    seatIndex: number;
    actionSeq: number;
    legalActions: LegalActions;
    deadlineTs: number;
  } | null {
    const state = this.#state;
    if (state.toActSeat === null || state.handId === null || this.#deadlineTs === null) return null;

    return {
      handId: state.handId,
      seatIndex: state.toActSeat,
      actionSeq: this.#actionSeq,
      legalActions: legalActions(state, state.toActSeat),
      deadlineTs: this.#deadlineTs,
    };
  }

  /**
   * The clock lives here, not on any client.
   *
   * `deadlineTs` is absolute epoch milliseconds, so a client with a skewed
   * clock draws a wrong countdown and still gets exactly the same amount of
   * real time to act.
   */
  #armTimer(): void {
    this.#clearTimer();

    const state = this.#state;
    const seatIndex = state.toActSeat;
    const handId = state.handId;
    if (seatIndex === null || handId === null || this.#closed) return;

    const timeoutMs = this.config.actionTimeoutSec * 1000;
    this.#deadlineTs = this.#scheduler.now() + timeoutMs;
    this.#cancelTimer = this.#scheduler.schedule(() => {
      void this.#timeout(seatIndex, handId);
    }, timeoutMs);

    const prompt = this.#currentPrompt();
    if (!prompt) return;
    for (const connection of this.#connections.values()) sendActionPrompt(connection, prompt);
  }

  /** The pause between the cards going face up and the chips moving. */
  #armBeat(): void {
    if (this.#state.phase !== 'showdown' || this.#closed) return;
    if (this.#cancelBeat !== null) return;

    const handId = this.#state.handId;
    this.#cancelBeat = this.#scheduler.schedule(() => {
      this.#cancelBeat = null;
      void this.#enqueue(() => {
        if (this.#state.phase !== 'showdown' || this.#state.handId !== handId) return;
        this.#dispatch({ type: 'ADVANCE_STREET' }, { fullSync: false });
      });
    }, this.#timings.showdownBeatMs);
  }

  /**
   * The gap before a hand is dealt.
   *
   * Deliberately not instant. Four people who sit down at the same moment
   * finish clicking at slightly different times, and dealing on the second of
   * them would leave the other two watching a hand they were a fraction of a
   * second too late for. The same pause serves as time to read the last result.
   */
  #armDeal(): void {
    if (!this.#canDeal() || this.#cancelDeal !== null) return;

    this.#cancelDeal = this.#scheduler.schedule(() => {
      this.#cancelDeal = null;
      void this.#enqueue(() => {
        this.#startHand();
      });
    }, this.#timings.dealDelayMs);
  }

  #clearTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#deadlineTs = null;
  }

  #cancelBeatTimer(): void {
    this.#cancelBeat?.();
    this.#cancelBeat = null;
  }

  #cancelDealTimer(): void {
    this.#cancelDeal?.();
    this.#cancelDeal = null;
  }

  #handInProgress(): boolean {
    const phase = this.#state.phase;
    return phase !== 'waiting' && phase !== 'hand_end';
  }

  #requireSeat(userId: string): number {
    const seatIndex = seatIndexOf(this.#state, userId);
    if (seatIndex === null) throw TableError.forbidden('take a seat first');
    return seatIndex;
  }

  #context(): RedactionContext {
    return {
      tableCode: this.code,
      members: this.#members,
      sessions: this.#sessions,
      actionDeadlineTs: this.#deadlineTs,
      revealedSeats: this.#revealed,
      muckedSeats: this.#mucked,
      hostUserId: this.hostUserId,
      paused: this.#paused,
      deckCommit: this.#deckCommit,
    };
  }

  /**
   * A client's action, checked against the legal set the engine reports.
   *
   * BET and RAISE carry a total to commit on this street. Anything outside
   * [minRaiseTo, maxRaiseTo] is refused here, before the engine sees it.
   */
  #toEngineAction(
    payload: PlayerActionPayload,
    legal: LegalActions,
    state: TableState,
    seatIndex: number,
  ): PlayerActionInput {
    const refuse = (what: string): never => {
      throw TableError.invalidAction(`you cannot ${what} here`);
    };

    switch (payload.type) {
      case 'FOLD':
        if (!legal.canFold) refuse('fold');
        return { type: 'FOLD' };

      case 'CHECK':
        if (!legal.canCheck) refuse('check');
        return { type: 'CHECK' };

      case 'CALL':
        if (!legal.canCall) refuse('call');
        return { type: 'CALL' };

      case 'BET':
      case 'RAISE': {
        const allowed = payload.type === 'BET' ? legal.canBet : legal.canRaise;
        if (!allowed) refuse(payload.type === 'BET' ? 'bet' : 'raise');

        const amount = payload.amount;
        if (amount === undefined) {
          throw TableError.invalidInput(`a ${payload.type.toLowerCase()} needs an amount`);
        }
        if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
          throw TableError.invalidInput(
            `${String(amount)} is outside the legal range [${String(legal.minRaiseTo)}, ${String(legal.maxRaiseTo)}]`,
          );
        }
        return payload.type === 'BET' ? { type: 'BET', amount } : { type: 'RAISE', amount };
      }

      case 'ALL_IN': {
        const seat = state.seats[seatIndex];
        const coversTheCall = seat
          ? seat.committedThisRound + seat.stack <= state.currentBet
          : false;
        if (!legal.canBet && !legal.canRaise && !coversTheCall) refuse('go all in');
        return { type: 'ALL_IN' };
      }
    }
  }

  /**
   * Every change to the table goes through here, one at a time.
   *
   * Two sockets landing in the same tick are still applied in order, and a task
   * that throws leaves the queue usable for the next one.
   */
  #enqueue<T>(task: () => T): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
