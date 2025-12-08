/**
 * Proton Drive Sync - Signal Management
 *
 * Inter-process communication via a signal queue stored in SQLite.
 * Uses EventEmitter for 1-to-N in-process signal broadcasting.
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const SIGNAL_POLL_INTERVAL_MS = 1000;

export const SYNC_PROCESS_PATTERN = 'proton-drive-sync.* start';

// Central event emitter for signal broadcasting
const signalEmitter = new EventEmitter();

let pollingInterval: NodeJS.Timeout | null = null;

/**
 * Check if a proton-drive-sync process is currently running.
 */
export function isAlreadyRunning(excludeSelf = false): boolean {
  try {
    const result = execSync(`pgrep -f "${SYNC_PROCESS_PATTERN}"`, { encoding: 'utf-8' });
    const pids = result
      .trim()
      .split('\n')
      .filter((pid) => pid && (!excludeSelf || parseInt(pid) !== process.pid));
    return pids.length > 0;
  } catch {
    return false;
  }
}

/**
 * Send a signal by adding it to the signal queue.
 */
export function sendSignal(signal: string): void {
  db.insert(schema.signals).values({ signal, createdAt: new Date() }).run();
}

/**
 * Check if a specific signal is in the queue (for producer to verify consumption).
 */
export function hasSignal(signal: string): boolean {
  const row = db.select().from(schema.signals).where(eq(schema.signals.signal, signal)).get();
  return !!row;
}

/**
 * Remove a signal from the queue (cleanup on timeout).
 */
export function consumeSignal(signal: string): boolean {
  const row = db.select().from(schema.signals).where(eq(schema.signals.signal, signal)).get();
  if (!row) return false;
  db.delete(schema.signals).where(eq(schema.signals.id, row.id)).run();
  return true;
}

/**
 * Register a handler for a specific signal. Handler is called when signal is detected.
 */
export function registerSignalHandler(signal: string, handler: () => void): void {
  signalEmitter.on(signal, handler);
}

/**
 * Unregister a handler for a specific signal.
 */
export function unregisterSignalHandler(signal: string, handler: () => void): void {
  signalEmitter.off(signal, handler);
}

/**
 * Start the signal polling loop. Checks DB for signals and emits to registered handlers.
 */
export function startSignalListener(): void {
  if (pollingInterval) return;

  pollingInterval = setInterval(() => {
    const rows = db.select().from(schema.signals).all();

    for (const row of rows) {
      // Check if anyone is listening for this signal
      if (signalEmitter.listenerCount(row.signal) > 0) {
        signalEmitter.emit(row.signal);
        // Consume the signal after broadcasting
        db.delete(schema.signals).where(eq(schema.signals.id, row.id)).run();
      }
    }
  }, SIGNAL_POLL_INTERVAL_MS);
}

/**
 * Stop the signal polling loop.
 */
export function stopSignalListener(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

/**
 * Kill any running proton-drive-sync sync processes.
 */
export function killSyncProcesses(): boolean {
  try {
    execSync(`pkill -f "${SYNC_PROCESS_PATTERN}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
