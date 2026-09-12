import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { ApiError, HealthResponse } from '@poker/shared';
import type { AuthDependencies } from './auth/dependencies';
import { AuthError } from './auth/errors';
import { registerAuthRoutes } from './auth/routes';
import type { AppConfig } from './config';
import type { HistoryRecorder } from './history/recorder';
import { registerHistoryRoutes } from './history/routes';
import { registerStatsRoutes } from './stats/routes';
import type { StatsService } from './stats/service';
import { SERVER_VERSION } from './version';

/**
 * Builds the HTTP app without listening, so tests can drive it with
 * `app.inject()` and never bind a port.
 *
 * No game logic belongs in here. Route handlers call into @poker/engine and
 * serialise through redactFor() - see CLAUDE.md.
 */
export async function buildApp(
  config: AppConfig,
  auth: AuthDependencies,
  history?: HistoryRecorder,
  stats?: StatsService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerFor(config),
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
  });
  await app.register(cookie);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AuthError) {
      if (error.retryAfter !== null) reply.header('retry-after', String(error.retryAfter));
      return reply.status(error.status).send(error.toBody());
    }

    if (error.validation || error.statusCode === 400) {
      const body: ApiError = { code: 'INVALID_INPUT', message: 'that request did not make sense' };
      return reply.status(400).send(body);
    }

    // Anything else is ours, not the client's: log it, say nothing revealing.
    request.log.error({ err: error }, 'unhandled error');
    const body: ApiError = { code: 'INTERNAL', message: 'something went wrong on our side' };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((_request, reply) => {
    const body: ApiError = { code: 'NOT_FOUND', message: 'no such endpoint' };
    return reply.status(404).send(body);
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      version: SERVER_VERSION,
    };
  });

  registerAuthRoutes(app, auth);
  if (history) registerHistoryRoutes(app, { recorder: history, auth });
  if (stats) registerStatsRoutes(app, { stats, auth });

  return app;
}

function loggerFor(config: AppConfig) {
  if (config.NODE_ENV === 'test') return false;
  if (config.NODE_ENV === 'development') {
    return {
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  }
  return { level: 'info' };
}
