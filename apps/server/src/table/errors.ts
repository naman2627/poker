import type { ApiError, ErrorCode } from '@poker/shared';

/**
 * Anything a client did wrong at a table. The socket layer turns one of these
 * into a failed ack; everything else that escapes becomes a flat INTERNAL, so a
 * bug never explains itself to a player.
 */
export class TableError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'TableError';
    this.code = code;
  }

  static notFound(message: string): TableError {
    return new TableError('NOT_FOUND', message);
  }

  static invalidInput(message: string): TableError {
    return new TableError('INVALID_INPUT', message);
  }

  static invalidAction(message: string): TableError {
    return new TableError('INVALID_ACTION', message);
  }

  static forbidden(message: string): TableError {
    return new TableError('FORBIDDEN', message);
  }

  static conflict(message: string): TableError {
    return new TableError('CONFLICT', message);
  }

  static rateLimited(message: string): TableError {
    return new TableError('RATE_LIMITED', message);
  }

  toBody(): ApiError {
    return { code: this.code, message: this.message };
  }
}
