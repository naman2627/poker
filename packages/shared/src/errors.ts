import { z } from 'zod';

export const ErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'INVALID_ACTION',
  'CONFLICT',
  'RATE_LIMITED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /** Seconds to wait before retrying. Present on RATE_LIMITED, and only there. */
  retryAfter: z.number().int().nonnegative().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Envelope for socket acknowledgements. The server never throws at a client;
 * it answers with one of these.
 */
export type Ack<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export const ackSchema = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: ApiErrorSchema }),
  ]);
