import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Repo root, from either `src/config.ts` (tsx) or `dist/index.js` (built).
 * Both sit two directories below apps/server.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Loads the root .env if present. Real deployments set real env vars instead. */
export function loadDotEnv(): void {
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
}

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),

  // Auth needs all four of these. They stay optional in the schema so tests can
  // build an app with doubles, and are required below whenever auth is wired.
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  SMS_PROVIDER: z.enum(['console', 'twilio', 'msg91']).default('console'),
  SMS_API_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),

  /**
   * Where accounts live. `memory` needs no Postgres and no Redis and loses
   * everything on restart; it is for local development and the end-to-end test,
   * and is refused outright in production.
   */
  AUTH_STORE: z.enum(['postgres', 'memory']).default('postgres'),

  /** The table's own pauses, in milliseconds. Shortened by the e2e run. */
  SHOWDOWN_BEAT_MS: z.coerce.number().int().min(0).max(30_000).default(2_000),
  DEAL_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(2_500),

  /**
   * A fixed shuffle, for a test that has to know what the cards are. Unset in
   * every real deployment, and refused outright in production — a predictable
   * deck is not a debugging aid at a table people are playing at.
   */
  TABLE_RNG_SEED: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * The same config, with everything auth needs proven present.
 *
 * `assertAuthConfig` is the one place that turns "probably configured" into a
 * type the wiring can rely on, so nothing downstream carries a `?` for a value
 * the process cannot run without.
 */
export type AuthConfig = AppConfig & {
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;
};

export function assertAuthConfig(config: AppConfig): AuthConfig {
  const missing = (['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'] as const)
    .filter((key) => !config[key])
    .join(', ');

  if (missing) {
    throw new Error(`Auth needs ${missing}. See .env.example for how to fill them in.`);
  }
  if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be different values.');
  }

  return config as AuthConfig;
}

/**
 * Parses process.env once, at boot. Empty values are treated as absent so a
 * copied-but-unfilled .env behaves the same as no .env at all.
 */
/**
 * Guards the two settings that would be a hole rather than a convenience if they
 * ever reached production: a deck anybody can predict, and accounts held in RAM.
 */
export function assertNotProduction(config: AppConfig): void {
  if (config.NODE_ENV !== 'production') return;

  if (config.TABLE_RNG_SEED !== undefined) {
    throw new Error('TABLE_RNG_SEED makes every shuffle predictable. It is refused in production.');
  }
  if (config.AUTH_STORE === 'memory') {
    throw new Error(
      'AUTH_STORE=memory keeps every account in RAM and loses them on restart. ' +
        'It is refused in production — set DATABASE_URL and REDIS_URL instead.',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const parsed = ConfigSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}\n\nSee .env.example.`);
  }

  return parsed.data;
}
