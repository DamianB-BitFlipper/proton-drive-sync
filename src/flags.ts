/**
 * Proton Drive Sync - Flag Management
 *
 * Flags: Persistent process state (running, paused, etc) stored in SQLite.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

// Flag names
export const FLAGS = {
  RUNNING: 'running',
  PAUSED: 'paused',
} as const;

/**
 * Set a flag (persistent state).
 */
export function setFlag(name: string): void {
  db.insert(schema.flags).values({ name, createdAt: new Date() }).onConflictDoNothing().run();
}

/**
 * Clear a flag (persistent state).
 */
export function clearFlag(name: string): void {
  db.delete(schema.flags).where(eq(schema.flags.name, name)).run();
}

/**
 * Check if a flag is set.
 */
export function hasFlag(name: string): boolean {
  const row = db.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
  return !!row;
}

/**
 * Check if a proton-drive-sync process is currently running.
 */
export function isAlreadyRunning(): boolean {
  return hasFlag(FLAGS.RUNNING);
}

/**
 * Check if syncing is paused.
 */
export function isPaused(): boolean {
  return hasFlag(FLAGS.PAUSED);
}

/**
 * Acquire the run lock: checks if another instance is running and marks this process as running.
 * Returns true if lock acquired, false if another instance is already running.
 * In dev mode (PROTON_DEV=1), forces lock acquisition for hot reload support.
 */
export function acquireRunLock(): boolean {
  const isDevMode = process.env.PROTON_DEV === '1';

  return db.transaction((tx) => {
    // Check if already running
    const existing = tx
      .select()
      .from(schema.flags)
      .where(eq(schema.flags.name, FLAGS.RUNNING))
      .get();

    if (existing && !isDevMode) {
      return false;
    }

    // Clear all stale signals
    tx.delete(schema.signals).run();

    // Set running flag
    tx.delete(schema.flags).where(eq(schema.flags.name, FLAGS.RUNNING)).run();
    tx.insert(schema.flags).values({ name: FLAGS.RUNNING, createdAt: new Date() }).run();

    return true;
  });
}

/**
 * Release the run lock: removes the "running" flag.
 * Should be called during graceful shutdown.
 */
export function releaseRunLock(): void {
  clearFlag(FLAGS.RUNNING);
}
