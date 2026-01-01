/**
 * Proton Drive Sync - Signal Management
 *
 * Signals: Transient inter-process communication via a queue stored in SQLite.
 * Uses EventEmitter for 1-to-N in-process signal broadcasting.
 */

import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const SIGNAL_POLL_INTERVAL_MS = 1000;

// Central event emitter for signal broadcasting
const signalEmitter = new EventEmitter();

let pollingInterval: NodeJS.Timeout | null = null;

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
    db.transaction((tx) => {
      const rows = tx.select().from(schema.signals).all();

      for (const row of rows) {
        // Check if anyone is listening for this signal
        if (signalEmitter.listenerCount(row.signal) > 0) {
          // Consume the signal BEFORE broadcasting (handler may exit process)
          tx.delete(schema.signals).where(eq(schema.signals.id, row.id)).run();
          signalEmitter.emit(row.signal);
        }
      }
    });
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
