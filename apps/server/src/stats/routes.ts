import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  LeaderboardMetricSchema,
  LeaderboardPeriodSchema,
  type LeaderboardResponse,
  type PlayerProfileResponse,
} from '@poker/shared';
import { z } from 'zod';
import type { AuthDependencies } from '../auth/dependencies';
import { AuthError } from '../auth/errors';
import type { StatsService } from './service';

/**
 * Reading the boards.
 *
 * Two endpoints, and the same rule the history routes follow: signing in is
 * required, membership of anything is not. A leaderboard is the one place in
 * this product where being seen by strangers is the point, so anybody with an
 * account can read any board and any player's page.
 *
 * What is on those pages is deliberately narrow. Counters, ranks, and a list of
 * hands with their outcomes — never a card. A player's recent hands say what
 * they won and lost and whether they got to a showdown; what they were holding
 * is still `GET /hands/:id`, which redacts per reader (see `history/routes.ts`).
 */
export interface StatsRouteDeps {
  readonly stats: StatsService;
  readonly auth: AuthDependencies;
}

const QuerySchema = z.object({
  metric: LeaderboardMetricSchema.default('net'),
  period: LeaderboardPeriodSchema.default('alltime'),
});

const UserIdSchema = z.uuid();

export function registerStatsRoutes(app: FastifyInstance, deps: StatsRouteDeps): void {
  /**
   * The top fifty, on one metric, over one period.
   *
   * Answered from a sorted set, cached for thirty seconds, and never by
   * aggregating the record of play. The viewer's own row comes back alongside
   * whether or not they are in the fifty — which is the whole reason the client
   * can pin it.
   */
  app.get('/leaderboard', async (request): Promise<LeaderboardResponse> => {
    const viewer = await viewerOf(request, deps);
    const { metric, period } = parseQuery(request.query);

    return deps.stats.leaderboard(metric, period, viewer);
  });

  /** One player's card, their all-time ranks, and their last twenty hands. */
  app.get('/players/:id', async (request): Promise<PlayerProfileResponse> => {
    await viewerOf(request, deps);
    const userId = parseUserId(request.params);

    const profile = await deps.stats.player(userId);
    if (!profile) throw AuthError.notFound('no such player');

    return profile;
  });
}

async function viewerOf(request: FastifyRequest, deps: StatsRouteDeps): Promise<string> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw AuthError.unauthenticated('this endpoint needs an access token');
  }
  const user = await deps.auth.tokens.authenticate(header.slice('Bearer '.length).trim());
  return user.id;
}

function parseQuery(query: unknown): z.infer<typeof QuerySchema> {
  const parsed = QuerySchema.safeParse(query ?? {});
  if (!parsed.success) throw AuthError.invalidInput('that is not a board this server keeps');
  return parsed.data;
}

function parseUserId(params: unknown): string {
  const parsed = UserIdSchema.safeParse((params as { id?: unknown }).id);
  if (!parsed.success) throw AuthError.invalidInput('that is not a player id');
  return parsed.data;
}
