/**
 * Dashboard Server - Spawns dashboard as a separate process
 *
 * The dashboard runs in its own process for true parallelism,
 * communicating via JSON over stdin/stdout.
 */

import { type Subprocess } from 'bun';
import { jobEvents, type JobEvent } from '../sync/queue.js';
import { logger } from '../logger.js';
import type { Config } from '../config.js';
import {
  type AuthStatusUpdate,
  type SyncStatus,
  type DashboardStatus,
  type DashboardJob,
  type DashboardDiff,
  type ParentMessage,
  type ChildMessage,
  createEmptyDiff,
  hasDiffChanges,
  parseMessage,
} from './ipc.js';

// Re-export types for external use
export type {
  AuthStatus,
  AuthStatusUpdate,
  SyncStatus,
  DashboardStatus,
  DashboardJob,
  DashboardDiff,
} from './ipc.js';

// ============================================================================
// Constants
// ============================================================================

// Accumulate diffs for this interval before sending to child
const DIFF_ACCUMULATE_MS = 100;

// ============================================================================
// Event Accumulation
// ============================================================================

/**
 * Accumulate a job event into the current diff.
 *
 * Event types and their effects on stats:
 * - enqueue: pending++ (job added to queue)
 * - processing: pending--, processing++ (job picked up for processing)
 * - synced: processing--, synced++ (job completed)
 * - blocked: processing--, blocked++ (job failed permanently)
 * - retry: processing--, pending++ (job scheduled for retry)
 */
function accumulateEvent(event: JobEvent): void {
  const job: DashboardJob = {
    id: event.jobId,
    localPath: event.localPath,
    remotePath: event.remotePath,
    createdAt: event.timestamp,
  };

  switch (event.type) {
    case 'enqueue':
      accumulatedDiff.statsDelta.pending++;
      break;

    case 'processing':
      accumulatedDiff.statsDelta.pending--;
      accumulatedDiff.statsDelta.processing++;
      if (event.wasRetry) {
        accumulatedDiff.statsDelta.retry--;
      }
      accumulatedDiff.addProcessing.push(job);
      break;

    case 'synced':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.synced++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      accumulatedDiff.addRecent.push(job);
      break;

    case 'blocked':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.blocked++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      accumulatedDiff.addBlocked.push({
        ...job,
        lastError: event.error,
      });
      break;

    case 'retry':
      accumulatedDiff.statsDelta.processing--;
      accumulatedDiff.statsDelta.pending++;
      accumulatedDiff.statsDelta.retry++;
      accumulatedDiff.removeProcessing.push(event.jobId);
      break;
  }
}

// ============================================================================
// Server Management
// ============================================================================

/** Type for our dashboard subprocess with piped stdin/stdout */
type DashboardSubprocess = Subprocess<'pipe', 'pipe', 'inherit'>;

let dashboardProcess: DashboardSubprocess | null = null;
let jobEventHandler: ((event: JobEvent) => void) | null = null;
let accumulatedDiff: DashboardDiff = createEmptyDiff();
let diffTimeout: ReturnType<typeof setTimeout> | null = null;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let currentAuthStatus: AuthStatusUpdate = { status: 'unauthenticated' };
let lastSentStatus: DashboardStatus | null = null;
let lastSyncHeartbeat: number = 0;
let lastPausedState = false;

// How long to wait before considering sync loop dead (90 seconds)
const SYNC_HEARTBEAT_TIMEOUT_MS = 90_000;

// Heartbeat interval (1.5 seconds) - checks for status changes
const HEARTBEAT_INTERVAL_MS = 1500;

/**
 * Send a message to the dashboard subprocess via stdin.
 * Bun's stdin is a FileSink when using stdin: 'pipe'.
 */
function sendToChild(message: ParentMessage): void {
  if (!dashboardProcess?.stdin) return;
  // Bun's FileSink has a write() method that accepts strings
  dashboardProcess.stdin.write(JSON.stringify(message) + '\n');
}

/**
 * Read and process messages from the dashboard subprocess stdout.
 */
async function readChildMessages(stdout: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (!line.trim()) continue;

        const msg = parseMessage<ChildMessage>(line);
        if (!msg) continue;

        if (msg.type === 'ready') {
          logger.info(`Dashboard running at http://localhost:${msg.port}`);

          // Send initial status when dashboard is ready
          sendStatusToDashboard();

          // Start heartbeat loop to continuously send status
          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }
          heartbeatInterval = setInterval(sendStatusToDashboard, HEARTBEAT_INTERVAL_MS);
        } else if (msg.type === 'error') {
          logger.error(`Dashboard server error: ${msg.error} (code: ${msg.code})`);
        } else if (msg.type === 'log') {
          // Forward dashboard logs to main logger with [dashboard] tag
          const taggedMessage = `[dashboard] ${msg.message}`;
          logger[msg.level](taggedMessage);
        }
      }
    }
  } catch (err) {
    // Stream closed, process likely exited
    logger.debug(`Dashboard stdout stream closed: ${err}`);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Start the dashboard in a separate process.
 */
export function startDashboard(config: Config, dryRun = false): void {
  if (dashboardProcess) {
    logger.warn('Dashboard process already running');
    return;
  }

  logger.debug(`Dashboard starting with dryRun=${dryRun}`);

  dashboardProcess = Bun.spawn(['proton-drive-sync', 'start', '--dashboard'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
    env: { ...process.env },
  });

  // Set up SIGTERM handler to clean up dashboard child on parent exit
  // This ensures clean restarts when using bun --watch
  process.on('SIGTERM', () => {
    if (dashboardProcess) {
      dashboardProcess.kill();
    }
  });
  process.on('SIGINT', () => {
    if (dashboardProcess) {
      dashboardProcess.kill();
    }
  });

  // Read messages from child stdout
  if (dashboardProcess.stdout) {
    readChildMessages(dashboardProcess.stdout);
  }

  // Handle child process exit
  dashboardProcess.exited.then((code) => {
    if (code !== 0) {
      logger.warn(`Dashboard process exited with code ${code}`);
    }
    dashboardProcess = null;
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }
  });

  // Send initial config
  sendToChild({ type: 'config', config, dryRun });

  // Forward job events to child process via stdin (accumulated into diffs)
  jobEventHandler = (event: JobEvent) => {
    if (!dashboardProcess) return;

    // Accumulate the event into the diff based on event type
    accumulateEvent(event);

    // Schedule sending the diff if not already scheduled
    if (!diffTimeout) {
      diffTimeout = setTimeout(() => {
        diffTimeout = null;
        if (dashboardProcess && hasDiffChanges(accumulatedDiff)) {
          sendToChild({ type: 'job_state_diff', diff: accumulatedDiff });
          accumulatedDiff = createEmptyDiff();
        }
      }, DIFF_ACCUMULATE_MS);
    }
  };
  jobEvents.on('job', jobEventHandler);
}

/**
 * Stop the dashboard process.
 */
export async function stopDashboard(): Promise<void> {
  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  if (dashboardProcess) {
    // Remove event listener
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }

    const proc = dashboardProcess;
    dashboardProcess = null;

    // Kill and wait for process to exit
    proc.kill();
    await proc.exited;

    logger.debug('Dashboard process stopped');
  }
}

/**
 * Send current status (auth + syncStatus) to the dashboard subprocess.
 * Always sends a heartbeat, but only includes status data if changed.
 * Called on heartbeat interval and when auth/sync status changes.
 *
 * @param options.auth - Auth status update (stores and sends immediately)
 * @param options.paused - Sync loop heartbeat with paused state (updates heartbeat timestamp)
 * @param options.disconnected - If true, marks sync as disconnected (resets heartbeat to 0)
 */
export function sendStatusToDashboard(options?: {
  auth?: AuthStatusUpdate;
  paused?: boolean;
  disconnected?: boolean;
}): void {
  // Update stored state based on options
  if (options?.auth) {
    currentAuthStatus = options.auth;
  }
  if (options?.paused !== undefined) {
    lastSyncHeartbeat = Date.now();
    lastPausedState = options.paused;
  }
  if (!dashboardProcess) return;

  // Determine sync status
  const heartbeatRecent = Date.now() - lastSyncHeartbeat < SYNC_HEARTBEAT_TIMEOUT_MS;
  let syncStatus: SyncStatus;
  if (!heartbeatRecent || options?.disconnected) {
    syncStatus = 'disconnected';
  } else if (lastPausedState) {
    syncStatus = 'paused';
  } else {
    syncStatus = 'syncing';
  }

  const status: DashboardStatus = {
    auth: currentAuthStatus,
    syncStatus,
  };

  // Helper to safely get username from auth status
  const getUsername = (auth: AuthStatusUpdate) =>
    auth.status === 'authenticated' ? auth.username : undefined;

  // Check if status has actually changed (compare values, not just presence of options)
  const hasChanged =
    !lastSentStatus ||
    lastSentStatus.syncStatus !== status.syncStatus ||
    lastSentStatus.auth.status !== status.auth.status ||
    getUsername(lastSentStatus.auth) !== getUsername(status.auth);

  if (hasChanged) {
    sendToChild({ type: 'status', ...status });
    lastSentStatus = status;
  } else {
    // Always send heartbeat to keep SSE connection alive
    sendToChild({ type: 'heartbeat' });
  }
}
