import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated from src/db/schema.ts and committed. Generating them
 * needs no database; applying them does.
 *
 *   pnpm --filter @poker/server db:generate   # schema -> SQL, offline
 *   pnpm --filter @poker/server db:migrate    # SQL -> the database in DATABASE_URL
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://poker:poker@localhost:5432/poker',
  },
  strict: true,
  verbose: true,
});
