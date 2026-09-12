import type { ApiError, ErrorCode } from '@poker/shared';

/**
 * Every failure a client is allowed to see. The route layer turns these into a
 * status code and an ApiError body; anything else that escapes becomes a 500
 * with no detail, because an unexpected error is not a message for a client.
 */
export class AuthError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfter: number | null;

  constructor(code: ErrorCode, status: number, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }

  static invalidInput(message: string): AuthError {
    return new AuthError('INVALID_INPUT', 400, message);
  }

  static unauthenticated(message: string): AuthError {
    return new AuthError('UNAUTHENTICATED', 401, message);
  }

  static forbidden(message: string): AuthError {
    return new AuthError('FORBIDDEN', 403, message);
  }

  static notFound(message: string): AuthError {
    return new AuthError('NOT_FOUND', 404, message);
  }

  static conflict(message: string): AuthError {
    return new AuthError('CONFLICT', 409, message);
  }

  static rateLimited(retryAfterSec: number, message: string): AuthError {
    return new AuthError('RATE_LIMITED', 429, message, Math.max(1, Math.ceil(retryAfterSec)));
  }

  toBody(): ApiError {
    return this.retryAfter === null
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retryAfter: this.retryAfter };
  }
}
