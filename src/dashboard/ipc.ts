/**
 * Dashboard IPC Types and Utilities
 *
 * Defines the message types for communication between the main sync process
 * (parent) and the dashboard subprocess (child) via stdin/stdout JSON streams.
 */

import type { Config } from '../config.js';

// ============================================================================
// Shared Types (used by both parent and child)
// ============================================================================

/** Authentication status */
export type AuthStatus = 'unauthenticated' | 'authenticating' | 'authenticated' | 'failed';

/** Authentication status update with optional username */
export interface AuthStatusUpdate {
  status: AuthStatus;
  username?: string;
}

/** Sync status for three-state badge */
export type SyncStatus = 'syncing' | 'paused' | 'disconnected';

/** Combined status for dashboard display */
export interface DashboardStatus {
  auth: AuthStatusUpdate;
  syncStatus: SyncStatus;
}

/** A job item for display in the dashboard */
export interface DashboardJob {
  id: number;
  localPath: string;
  remotePath?: string | null;
  lastError?: string | null;
  nRetries?: number;
  retryAt?: Date;
  createdAt?: Date;
}

/** Accumulated job state changes to send to frontend */
export interface DashboardDiff {
  /** Stats deltas: positive = increment, negative = decrement */
  statsDelta: {
    pending: number;
    processing: number;
    synced: number;
    blocked: number;
    retry: number;
  };
  /** Jobs to add to the processing list */
  addProcessing: DashboardJob[];
  /** Job IDs to remove from the processing list */
  removeProcessing: number[];
  /** Jobs to add to the recent (synced) list */
  addRecent: DashboardJob[];
  /** Jobs to add to the blocked list */
  addBlocked: DashboardJob[];
}

// ============================================================================
// Parent → Child Messages (sent via stdin)
// ============================================================================

/** Initial configuration message sent once at startup */
export interface ConfigMessage {
  type: 'config';
  config: Config;
  dryRun: boolean;
}

/** Job state diff message sent on job events */
export interface JobStateDiffMessage {
  type: 'job_state_diff';
  diff: DashboardDiff;
}

/** Status update message sent on auth/sync status changes */
export interface StatusMessage {
  type: 'status';
  auth: AuthStatusUpdate;
  syncStatus: SyncStatus;
}

/** Heartbeat message sent periodically to keep connection alive */
export interface HeartbeatMessage {
  type: 'heartbeat';
}

/** Union of all messages parent can send to child */
export type ParentMessage = ConfigMessage | JobStateDiffMessage | StatusMessage | HeartbeatMessage;

// ============================================================================
// Child → Parent Messages (sent via stdout)
// ============================================================================

/** Ready message sent when dashboard server starts successfully */
export interface ReadyMessage {
  type: 'ready';
  port: number;
}

/** Error message sent when dashboard server fails to start */
export interface ErrorMessage {
  type: 'error';
  error: string;
  code?: string;
}

/** Log message sent from dashboard to parent for forwarding to main logger */
export interface LogMessage {
  type: 'log';
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
}

/** Union of all messages child can send to parent */
export type ChildMessage = ReadyMessage | ErrorMessage | LogMessage;

// ============================================================================
// Utilities
// ============================================================================

/** Create an empty diff */
export function createEmptyDiff(): DashboardDiff {
  return {
    statsDelta: { pending: 0, processing: 0, synced: 0, blocked: 0, retry: 0 },
    addProcessing: [],
    removeProcessing: [],
    addRecent: [],
    addBlocked: [],
  };
}

/** Check if a diff has any changes worth sending */
export function hasDiffChanges(diff: DashboardDiff): boolean {
  return (
    diff.statsDelta.pending !== 0 ||
    diff.statsDelta.processing !== 0 ||
    diff.statsDelta.synced !== 0 ||
    diff.statsDelta.blocked !== 0 ||
    diff.statsDelta.retry !== 0 ||
    diff.addProcessing.length > 0 ||
    diff.removeProcessing.length > 0 ||
    diff.addRecent.length > 0 ||
    diff.addBlocked.length > 0
  );
}

/**
 * Send a message to stdout as newline-delimited JSON.
 * Used by child process to communicate with parent.
 */
export function sendToParent(message: ChildMessage): void {
  console.log(JSON.stringify(message));
}

/**
 * Parse a JSON message from a line of text.
 * Returns null if parsing fails.
 */
export function parseMessage<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}
