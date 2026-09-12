import { STREETS, type LegalActions, type Seat, type TableState } from './types';

const NOTHING: LegalActions = {
  canFold: false,
  canCheck: false,
  canCall: false,
  callAmount: 0,
  canBet: false,
  canRaise: false,
  minRaiseTo: 0,
  maxRaiseTo: 0,
};

/**
 * What this seat may do right now. This is the single source of truth for
 * legality: `reduce()` validates every PLAYER_ACTION against it, and a transport
 * should ask the same question before it offers a client any buttons.
 *
 * Every seat but the one to act gets a flat no.
 */
export function legalActions(state: TableState, seatIndex: number): LegalActions {
  if (!isBettingStreet(state)) return NOTHING;
  if (state.toActSeat !== seatIndex) return NOTHING;

  const seat = state.seats[seatIndex];
  if (!seat || seat.status !== 'active' || seat.stack <= 0) return NOTHING;

  const toCall = Math.max(0, state.currentBet - seat.committedThisRound);
  const maxRaiseTo = seat.committedThisRound + seat.stack;

  const canCheck = toCall === 0;
  const canCall = toCall > 0;
  const callAmount = Math.min(toCall, seat.stack);

  // With no bet in front of them a seat bets; facing one, it raises. Either way
  // the ceiling is its whole stack, and a shove is always available even when it
  // falls short of a full raise.
  const canBet = state.currentBet === 0;
  const canRaise = state.currentBet > 0 && maxRaiseTo > state.currentBet && canReopen(seat);

  const minBetTo = Math.min(state.bigBlind, maxRaiseTo);
  const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo);

  if (canBet) {
    return {
      canFold: true,
      canCheck,
      canCall: false,
      callAmount: 0,
      canBet: true,
      canRaise: false,
      minRaiseTo: minBetTo,
      maxRaiseTo,
    };
  }

  return {
    canFold: true,
    canCheck,
    canCall,
    callAmount,
    canBet: false,
    canRaise,
    minRaiseTo: canRaise ? minRaiseTo : 0,
    maxRaiseTo: canRaise ? maxRaiseTo : 0,
  };
}

/**
 * A seat may raise only if it has not yet acted since the last full bet or
 * raise. That flag is what closes the action to players an under-sized all-in
 * has already passed: it is cleared for everyone by a full raise, and left alone
 * by a short one, so those who already matched can call or fold but not re-raise
 * (CLAUDE.md rule 3), while anyone yet to act still has the full range.
 */
function canReopen(seat: Seat): boolean {
  return !seat.hasActedThisRound;
}

export function isBettingStreet(state: TableState): boolean {
  return (STREETS as readonly string[]).includes(state.phase);
}

/**
 * A betting round is over once every seat that can still act has acted since the
 * last aggression *and* has matched the current bet (CLAUDE.md rule 1). Seats
 * that are all-in or folded are not consulted; if nobody can act, the round is
 * already over.
 */
export function isBettingRoundComplete(state: TableState): boolean {
  return state.seats.every(
    (seat) =>
      seat === null ||
      seat.status !== 'active' ||
      (seat.hasActedThisRound && seat.committedThisRound === state.currentBet),
  );
}
