/**
 * Applies everything in ./drizzle to DATABASE_URL, then exits.
 *
 *   pnpm --filter @poker/server db:migrate
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig, loadDotEnv } from '../config';
import { createDatabase } from './client';

loadDotEnv();
const config = loadConfig();

if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to run migrations');
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');
const { db, close } = createDatabase(config.DATABASE_URL);

try {
  await migrate(db, { migrationsFolder });
  console.info(`migrations applied from ${migrationsFolder}`);
} finally {
  await close();
}
