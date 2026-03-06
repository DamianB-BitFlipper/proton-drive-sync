/**
 * Proton Drive Sync - Flag Management
 *
 * Flags: Persistent process state (running, paused, etc) stored in SQLite.
 */

import { eq, like } from 'drizzle-orm';
import { db, schema } from './db/index.js';

// Flag names
export const FLAGS = {
  PAUSED: 'paused',
  ONBOARDING: 'onboarding', // Data: 'about' or 'completed'
  SERVICE_INSTALLED: 'service_installed',
  SERVICE_LOADED: 'service_loaded',
  STARTUP_READY: 'startup_ready', // Set after auth + watcher initialization complete
} as const;

// Onboarding states (used as data for ONBOARDING flag)
export const ONBOARDING_STATE = {
  ABOUT: 'about',
  COMPLETED: 'completed',
} as const;

// Flag name for running PID (stored as "running_pid:<pid>")
const RUNNING_PID_FLAG = 'running_pid';

// Wildcard for clearing all variants of a flag
export const ALL_VARIANTS = '*';

// Type for db or transaction - both have the same query interface
type DbConnection = Pick<typeof db, 'insert' | 'delete' | 'select'>;

/**
 * Set a flag with optional data (stored as "flag_name:data" or just "flag_name").
 * If data is provided, clears any existing variant of this flag first.
 * Optionally accepts a transaction object for atomic operations.
 */
export function setFlag(name: string, data?: string, tx?: DbConnection): void {
  const conn = tx ?? db;
  if (data !== undefined) {
    // Clear any existing flag with this prefix first
    conn
      .delete(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .run();
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
  }
  const flagName = data !== undefined ? `${name}:${data}` : name;
  conn
    .insert(schema.flags)
    .values({ name: flagName, createdAt: new Date() })
    .onConflictDoNothing()
    .run();
}

/**
 * Clear a flag (persistent state).
 * If data is not set, clears the flag matching exactly.
 * If data is set, clears the flag with that exact data (e.g., "flag:data").
 * If data is ALL_VARIANTS (%), clears all variants of this flag.
 * Optionally accepts a transaction object for atomic operations.
 */
export function clearFlag(name: string, data?: string, tx?: DbConnection): void {
  const conn = tx ?? db;
  if (data === ALL_VARIANTS) {
    // Clear all variants: both "name" and "name:*"
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
    conn
      .delete(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .run();
  } else if (data !== undefined) {
    // Clear exact "name:data"
    conn
      .delete(schema.flags)
      .where(eq(schema.flags.name, `${name}:${data}`))
      .run();
  } else {
    // Clear exact "name"
    conn.delete(schema.flags).where(eq(schema.flags.name, name)).run();
  }
}

/**
 * Get the data portion of a flag (returns null if flag doesn't exist or has no data).
 * Optionally accepts a transaction object for atomic operations.
 */
export function getFlagData(name: string, tx?: DbConnection): string | null {
  const conn = tx ?? db;
  const row = conn
    .select()
    .from(schema.flags)
    .where(like(schema.flags.name, `${name}:%`))
    .get();
  if (!row) return null;
  return row.name.slice(name.length + 1);
}

/**
 * Check if a flag is set.
 * If data is not set, checks for exact flag name.
 * If data is set, checks for exact "name:data".
 * If data is ALL_VARIANTS (*), checks if any variant exists.
 * Optionally accepts a transaction object for atomic operations.
 */
export function hasFlag(name: string, data?: string, tx?: DbConnection): boolean {
  const conn = tx ?? db;
  if (data === ALL_VARIANTS) {
    // Check if any variant exists: "name" or "name:*"
    const exact = conn.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
    if (exact) return true;
    const variant = conn
      .select()
      .from(schema.flags)
      .where(like(schema.flags.name, `${name}:%`))
      .get();
    return !!variant;
  } else if (data !== undefined) {
    // Check exact "name:data"
    const row = conn
      .select()
      .from(schema.flags)
      .where(eq(schema.flags.name, `${name}:${data}`))
      .get();
    return !!row;
  } else {
    // Check exact "name"
    const row = conn.select().from(schema.flags).where(eq(schema.flags.name, name)).get();
    return !!row;
  }
}

/**
 * Check if a process with the given PID is currently running.
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a proton-drive-sync process is currently running.
 */
export function isAlreadyRunning(): boolean {
  const pidStr = getFlagData(RUNNING_PID_FLAG);
  if (!pidStr) return false;
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return false;
  return isProcessRunning(pid);
}

/**
 * Check if syncing is paused.
 */
export function isPaused(): boolean {
  return hasFlag(FLAGS.PAUSED);
}

/**
 * Check if the daemon has completed startup (auth + watcher ready).
 */
export function isStartupReady(): boolean {
  return hasFlag(FLAGS.STARTUP_READY);
}

/**
 * Acquire the run lock: checks if another instance is running and marks this process as running.
 * Returns true if lock acquired, false if another instance is already running.
 * If a stale lock exists (process no longer running), it will be cleared and lock acquired.
 */
export function acquireRunLock(): boolean {
  return db.transaction((tx) => {
    // Check if another process holds the lock
    const pidStr = getFlagData(RUNNING_PID_FLAG, tx);

    if (pidStr) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid === process.pid) {
        // Stale self-lock can happen after container/service restarts where PID is reused.
        clearFlag(RUNNING_PID_FLAG, pidStr, tx);
      } else if (!isNaN(pid) && isProcessRunning(pid)) {
        // Process is still running, can't acquire lock
        return false;
      } else {
        // Process is dead, clear stale lock
        clearFlag(RUNNING_PID_FLAG, pidStr, tx);
      }
    }

    // Clear all stale signals
    tx.delete(schema.signals).run();

    // Store our PID as the lock
    setFlag(RUNNING_PID_FLAG, String(process.pid), tx);

    return true;
  });
}

/**
 * Release the run lock: removes the running PID and paused flags.
 * Should be called during graceful shutdown.
 */
export function releaseRunLock(): void {
  clearFlag(FLAGS.STARTUP_READY);
  clearFlag(RUNNING_PID_FLAG, ALL_VARIANTS);
  clearFlag(FLAGS.PAUSED);
}
