import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof createDatabase>['db'];

/**
 * One connection pool for the process. `close()` is called on shutdown so a
 * restart does not leave sessions behind.
 */
export function createDatabase(url: string) {
  const sql = postgres(url, { max: 10 });
  const db = drizzle(sql, { schema });
  return {
    db,
    close: async (): Promise<void> => {
      await sql.end({ timeout: 5 });
    },
  };
}
