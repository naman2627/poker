import { Redis } from 'ioredis';
import { seededRng } from '@poker/engine';
import { buildApp } from './app';
import { createAuthDependencies, createMemoryAuthDependencies } from './auth/dependencies';
import { assertNotProduction, loadConfig, loadDotEnv } from './config';
import { createDatabase } from './db/client';
import { createMemoryHistorySink, type MemoryHistorySink } from './history/memory-sink';
import { createPostgresHistorySink } from './history/postgres-sink';
import { HistoryRecorder } from './history/recorder';
import type { HistorySink } from './history/sink';
import { attachRealtime } from './realtime';
import { createMemoryLeaderboardIndex } from './stats/memory-index';
import { createMemoryStatsStore } from './stats/memory-store';
import { createPostgresStatsStore } from './stats/postgres-store';
import { createRedisLeaderboardIndex } from './stats/redis-index';
import { StatsRecorder } from './stats/recorder';
import { startLeaderboardRebuilds } from './stats/rebuild';
import { createStatsService } from './stats/service';
import type { LeaderboardIndex, StatsStore } from './stats/ports';
import { TableRegistry } from './table/registry';

loadDotEnv();

const config = loadConfig();
assertNotProduction(config);

const auth =
  config.AUTH_STORE === 'memory'
    ? createMemoryAuthDependencies(config)
    : await createAuthDependencies(config);

if (config.AUTH_STORE === 'memory') {
  console.warn('AUTH_STORE=memory: accounts and sessions live in this process and die with it.');
}

/**
 * Whether there is anywhere durable to put things.
 *
 * With Postgres configured, the record of play and the counters behind the
 * leaderboards are both written down. Without it they live in Maps and die with
 * the process — which is what makes `pnpm dev` work on a laptop with nothing
 * installed, and what lets the end-to-end run play twenty hands and read a
 * board at the end of them without a container.
 */
const databaseUrl = config.AUTH_STORE === 'memory' ? undefined : config.DATABASE_URL;

const logger = {
  warn: (details: Record<string, unknown>, message: string) => {
    console.warn(message, details);
  },
  error: (details: Record<string, unknown>, message: string) => {
    console.error(message, details);
  },
  info: (details: Record<string, unknown>, message: string) => {
    console.info(message, details);
  },
};

/**
 * Where the record of play goes.
 *
 * Its own connection pool, deliberately: history writes are the one thing on
 * this server that may safely queue up and wait, and sharing a pool with auth
 * would let a slow write hold up a login.
 */
function buildHistorySink(): { sink: HistorySink; memory: MemoryHistorySink | null } {
  if (databaseUrl === undefined) {
    const memory = createMemoryHistorySink();
    return { sink: memory, memory };
  }
  const { db, close } = createDatabase(databaseUrl);
  return { sink: createPostgresHistorySink(db, close), memory: null };
}

const { sink: historySink, memory: memorySink } = buildHistorySink();
const history = new HistoryRecorder({ sink: historySink, logger });

/**
 * Where the count of play goes.
 *
 * Its own pool again, and for the same reason: a slow board must not be able to
 * hold up a login, and a slow login must not be able to hold up a hand being
 * counted.
 *
 * The memory store asks the memory history sink for names and for a player's
 * hands rather than keeping its own copies; in the Postgres build those two
 * questions are joins.
 */
const statsDb = databaseUrl === undefined ? null : createDatabase(databaseUrl);

const statsStore: StatsStore =
  statsDb === null
    ? createMemoryStatsStore({
        profileFor: (userId) => memorySink?.profileFor(userId) ?? null,
        handsFor: (userId, limit) => memorySink?.handsFor(userId, limit) ?? [],
      })
    : createPostgresStatsStore(statsDb.db, statsDb.close);

/**
 * The fast mirror of those counters.
 *
 * Absent Redis, the sorted sets live in Maps. Nothing about the read path
 * changes: both answer "top fifty" and "your rank" the same way, and both hold
 * only what `player_stats` already says.
 */
const statsRedis =
  statsDb !== null && config.REDIS_URL !== undefined
    ? new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 })
    : null;

const leaderboardIndex: LeaderboardIndex =
  statsRedis === null ? createMemoryLeaderboardIndex() : createRedisLeaderboardIndex(statsRedis);

const stats = new StatsRecorder({ store: statsStore, index: leaderboardIndex, logger });
const statsService = createStatsService({ store: statsStore, index: leaderboardIndex });

/**
 * Boot, and then hourly.
 *
 * Redis holds nothing that is not derived from `player_stats`, so an eviction,
 * a flush or a cold start costs a rebuild and never a number. Running it at
 * boot means a server that comes up against an empty Redis serves a correct
 * board immediately rather than one that fills in as people play.
 */
const stopRebuilds = startLeaderboardRebuilds({
  store: statsStore,
  index: leaderboardIndex,
  logger,
});

const app = await buildApp(config, auth, history, statsService);
if (config.TABLE_RNG_SEED !== undefined) {
  console.warn(`TABLE_RNG_SEED is set: every shuffle at every table is predictable.`);
}

const registry = new TableRegistry({
  history,
  stats,
  timings: {
    showdownBeatMs: config.SHOWDOWN_BEAT_MS,
    dealDelayMs: config.DEAL_DELAY_MS,
  },
  ...(config.TABLE_RNG_SEED === undefined ? {} : { rng: seededRng(config.TABLE_RNG_SEED) }),
});
const io = attachRealtime(app, { config, auth, registry });

await app.listen({ port: config.PORT, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void io
      .close()
      .then(() => app.close())
      .then(() => {
        registry.closeAll();
        stopRebuilds();
      })
      // Bounded: a database that is down must not stop the server stopping.
      .then(() => history.whenFlushed(5_000))
      .then(() => stats.whenFlushed(5_000))
      .then(() => history.close())
      .then(() => stats.close())
      .then(() => {
        statsRedis?.disconnect();
      })
      .then(() => auth.close())
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error({ error }, 'shutdown failed');
        process.exit(1);
      });
  });
}
