import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DB } from './types.js';

// numeric -> number, matching the generated types (numeric columns here are scores and ratios, not money).
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));

export type Database = Kysely<DB>;

export function createDb(connectionString: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client losing its connection must not crash the process; the pool replaces it.
  pool.on('error', (err) => console.error('postgres pool error', err.message));
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
