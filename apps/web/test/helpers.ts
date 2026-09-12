import type { PublicSeat, PublicTableState } from '@poker/shared';

/** A seat with sensible defaults, so a test only spells out what it cares about. */
export function seat(seatIndex: number, over: Partial<PublicSeat> = {}): PublicSeat {
  return {
    seatIndex,
    userId: `00000000-0000-4000-8000-00000000000${String(seatIndex)}`,
    displayName: `Seat ${String(seatIndex)}`,
    avatarSeed: null,
    stack: 1000,
    status: 'active',
    committedThisRound: 0,
    committedThisHand: 0,
    hasActedThisRound: false,
    cardCount: 0,
    holeCards: null,
    isReady: true,
    sittingOut: false,
    leaving: false,
    ...over,
  };
}

export function tableState(over: Partial<PublicTableState> = {}): PublicTableState {
  return {
    tableCode: 'FELT42',
    handId: null,
    handNumber: 0,
    phase: 'waiting',
    buttonSeat: null,
    sbSeat: null,
    bbSeat: null,
    smallBlind: 5,
    bigBlind: 10,
    board: [],
    seats: [seat(0), seat(1), seat(2)],
    currentBet: 0,
    minRaise: 10,
    lastAggressorSeat: null,
    toActSeat: null,
    pots: [],
    deckRemaining: 52,
    actionDeadlineTs: null,
    viewerSeatIndex: 0,
    hostUserId: null,
    paused: false,
    deckCommit: null,
    muckedSeats: [],
    leaderboard: [],
    ...over,
  };
}
