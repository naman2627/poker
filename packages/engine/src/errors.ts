/**
 * The engine refuses illegal input by throwing. A transport should validate with
 * `legalActions()` first and treat an EngineError as a bug or a hostile client,
 * never as a normal branch.
 */
export type EngineErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'SEAT_NOT_FOUND'
  | 'SEAT_TAKEN'
  | 'SEAT_OUT_OF_RANGE'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_ACTION'
  | 'INVALID_AMOUNT'
  | 'INVALID_CONFIG'
  | 'DECK_EXHAUSTED'
  | 'ROUND_IN_PROGRESS'
  | 'INVALID_HAND'
  | 'POT_MISMATCH';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

export function fail(code: EngineErrorCode, message: string): never {
  throw new EngineError(code, message);
}
