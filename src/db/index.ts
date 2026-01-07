/**
 * Proton Drive Sync - Database Connection
 *
 * SQLite database using Drizzle ORM for state persistence.
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import type { Changes } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { getStateDir } from '../paths.js';

// Import migrations as text (embedded at compile time)
// When adding new migrations, add a new import and entry to the migrations array below
import migration0000 from './migrations/0000_hot_whizzer.sql' with { type: 'text' };
import migration0001 from './migrations/0001_unique_invisible_woman.sql' with { type: 'text' };
import migration0002 from './migrations/0002_flowery_apocalypse.sql' with { type: 'text' };
import migration0003 from './migrations/0003_real_sharon_carter.sql' with { type: 'text' };
import migration0004 from './migrations/0004_wise_mockingbird.sql' with { type: 'text' };
import migration0005 from './migrations/0005_opposite_venom.sql' with { type: 'text' };
import migration0006 from './migrations/0006_content_hash_tracking.sql' with { type: 'text' };
import migration0007 from './migrations/0007_drop_clocks_table.sql' with { type: 'text' };
import migration0008 from './migrations/0008_curvy_glorian.sql' with { type: 'text' };

const migrations = [
  { id: '0000_hot_whizzer', sql: migration0000 },
  { id: '0001_unique_invisible_woman', sql: migration0001 },
  { id: '0002_flowery_apocalypse', sql: migration0002 },
  { id: '0003_real_sharon_carter', sql: migration0003 },
  { id: '0004_wise_mockingbird', sql: migration0004 },
  { id: '0005_opposite_venom', sql: migration0005 },
  { id: '0006_content_hash_tracking', sql: migration0006 },
  { id: '0007_drop_clocks_table', sql: migration0007 },
  { id: '0008_curvy_glorian', sql: migration0008 },
];

// ============================================================================
// Constants
// ============================================================================

export const STATE_DIR = getStateDir();
const DB_PATH = join(STATE_DIR, 'state.db');

// ============================================================================
// Migration Runner
// ============================================================================

/**
 * Runs embedded migrations against the database.
 * Tracks applied migrations using content hashes (compatible with Drizzle's migrator).
 */
async function runMigrations(sqlite: Database) {
  // Create migrations tracking table if it doesn't exist (matches Drizzle's schema)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  // Get already applied migration hashes
  const applied = new Set(
    sqlite
      .query<{ hash: string }, []>('SELECT hash FROM __drizzle_migrations')
      .all()
      .map((row: { hash: string }) => row.hash)
  );

  // Apply pending migrations
  for (const migration of migrations) {
    // Use SHA256 hash to match Drizzle's approach
    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(migration.sql)
    );
    const hash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    if (applied.has(hash)) continue;

    // Execute each statement in the migration
    const statements = migration.sql
      .split('--> statement-breakpoint')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    for (const statement of statements) {
      sqlite.exec(statement);
    }

    // Record the migration with its hash
    sqlite
      .query('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(hash, Date.now());
  }
}

// ============================================================================
// Database Initialization
// ============================================================================

async function initializeDatabase() {
  // Ensure state directory exists
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }

  const sqlite = new Database(DB_PATH);

  // Configure SQLite for concurrent access (multiple processes may access the database)
  // WAL mode allows concurrent reads during writes and reduces lock contention
  sqlite.exec('PRAGMA journal_mode = WAL');
  // Busy timeout (5s) makes SQLite retry on lock instead of failing immediately
  sqlite.exec('PRAGMA busy_timeout = 5000');

  // Run embedded migrations
  await runMigrations(sqlite);

  const db = drizzle(sqlite, { schema });

  return db;
}

export const db = await initializeDatabase();
export { schema };

/** Transaction type for passing to functions that support transactional operations */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ============================================================================
// Drizzle Run Helper
// ============================================================================

/**
 * Execute a Drizzle query and return the Changes result.
 * Workaround for Drizzle ORM bun-sqlite driver typing bug where
 * .run() is typed as void but actually returns Changes.
 */
export function run<T extends { run(): void }>(query: T): Changes {
  return query.run() as unknown as Changes;
}
