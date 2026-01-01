/**
 * Proton Drive Sync - State Management
 *
 * Persists sync state to ~/.local/state/proton-drive-sync/state.db using SQLite.
 */

import { realpathSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema, STATE_DIR, type Tx } from './db/index.js';
import { getConfig } from './config.js';
import { logger } from './logger.js';

// Re-export STATE_DIR for other modules
export { STATE_DIR };

// ============================================================================
// Clock Management
// ============================================================================

/**
 * Get the watchman clock for a directory.
 */
export function getClock(directory: string): string | null {
  const row = db.select().from(schema.clocks).where(eq(schema.clocks.directory, directory)).get();
  return row?.clock ?? null;
}

/**
 * Set the watchman clock for a directory.
 * No-op if dryRun is true.
 */
export function setClock(directory: string, clock: string, dryRun: boolean): void {
  if (dryRun) return;

  logger.debug(`Setting clock for ${directory}: ${clock}`);

  db.insert(schema.clocks)
    .values({ directory, clock })
    .onConflictDoUpdate({
      target: schema.clocks.directory,
      set: { clock },
    })
    .run();
}

/**
 * Get all clocks as a record (for compatibility).
 */
export function getAllClocks(): Record<string, string> {
  const rows = db.select().from(schema.clocks).all();
  return Object.fromEntries(rows.map((row) => [row.directory, row.clock]));
}

/**
 * Delete the watchman clock for a directory.
 * No-op if dryRun is true.
 */
export function deleteClock(directory: string, dryRun: boolean, tx?: Tx): void {
  if (dryRun) return;
  logger.debug(`Deleting clock for ${directory}`);
  const target = tx ?? db;
  target.delete(schema.clocks).where(eq(schema.clocks.directory, directory)).run();
}

/**
 * Remove clock entries for directories no longer in sync_dirs config.
 */
export function cleanupOrphanedClocks(dryRun: boolean, tx: Tx): void {
  if (dryRun) return;

  const config = getConfig();
  const validDirs = new Set(config.sync_dirs.map((d) => realpathSync(d.source_path)));

  const allClocks = tx.select().from(schema.clocks).all();
  for (const clock of allClocks) {
    if (!validDirs.has(clock.directory)) {
      logger.info(`Removing orphaned clock for: ${clock.directory}`);
      tx.delete(schema.clocks).where(eq(schema.clocks.directory, clock.directory)).run();
    }
  }
}
