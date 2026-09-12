import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  TableCodeSchema,
  type HandDetail,
  type HandHistoryResponse,
  type HandVerification,
} from '@poker/shared';
import { z } from 'zod';
import { AuthError } from '../auth/errors';
import type { AuthDependencies } from '../auth/dependencies';
import type { HistoryRecorder } from './recorder';
import { redactHand, summarise } from './sink';
import { verifyHand } from './verify';

/**
 * Reading the record back.
 *
 * Three endpoints, and one rule running through all of them: what a reader is
 * shown is decided here, from who they are, and never from what happens to be
 * in the row. Your own cards, and anybody's who showed them. A hand that mucked
 * stays mucked, in the history as on the felt.
 *
 * Signing in is required — this is a private table's record, not a public feed —
 * but membership is not: anybody with an account can audit a hand they were
 * dealt out of, which is rather the point of publishing a commitment.
 */
export interface HistoryRouteDeps {
  readonly recorder: HistoryRecorder;
  readonly auth: AuthDependencies;
}

const HAND_LIMIT = 50;

/**
 * At most one hand per table is in progress, so asking for one extra and
 * dropping it leaves a full fifty finished ones.
 */
const FETCH_LIMIT = HAND_LIMIT + 1;

const HandIdSchema = z.uuid();

export function registerHistoryRoutes(app: FastifyInstance, deps: HistoryRouteDeps): void {
  app.get('/tables/:code/hands', async (request): Promise<HandHistoryResponse> => {
    // Summaries carry no cards, but reading a table's record still needs an
    // account: the code is the only thing protecting a private game.
    await viewerOf(request, deps);
    const code = parseCode(request.params);

    const hands = await deps.recorder.recentHands(code, FETCH_LIMIT);
    const status = deps.recorder.status;

    return {
      tableCode: code,
      // Finished hands only. The one being played has no winner and no pot to
      // report yet, and its row would say nothing but "unfinished" — the record
      // of it exists (that is what makes the audit live), it is just not
      // history until it is over.
      hands: hands
        .filter((hand) => hand.endedAt !== null)
        .slice(0, HAND_LIMIT)
        .map(summarise),
      // Said out loud rather than papered over: history is written off the
      // critical path, so a list can legitimately be behind the table.
      statsPaused: status.paused,
      pendingWrites: status.pending,
    };
  });

  app.get('/hands/:id', async (request): Promise<HandDetail> => {
    const viewer = await viewerOf(request, deps);
    const hand = await deps.recorder.hand(parseHandId(request.params));
    if (!hand) throw AuthError.notFound('no such hand');

    return redactHand(hand, viewer);
  });

  app.get('/hands/:id/verify', async (request): Promise<HandVerification> => {
    const viewer = await viewerOf(request, deps);
    const hand = await deps.recorder.hand(parseHandId(request.params));
    if (!hand) throw AuthError.notFound('no such hand');

    return verifyHand(hand, viewer);
  });
}

async function viewerOf(request: FastifyRequest, deps: HistoryRouteDeps): Promise<string> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AuthError.unauthenticated('this endpoint needs an access token');
  }
  const user = await deps.auth.tokens.authenticate(header.slice('Bearer '.length).trim());
  return user.id;
}

function parseCode(params: unknown): string {
  const parsed = TableCodeSchema.safeParse((params as { code?: unknown }).code);
  if (!parsed.success) throw AuthError.invalidInput('that is not a table code');
  return parsed.data;
}

function parseHandId(params: unknown): string {
  const parsed = HandIdSchema.safeParse((params as { id?: unknown }).id);
  if (!parsed.success) throw AuthError.invalidInput('that is not a hand id');
  return parsed.data;
}
