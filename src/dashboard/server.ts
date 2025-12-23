/**
 * Dashboard Server - Spawns dashboard as a separate process
 *
 * The dashboard runs in its own Node.js process for true parallelism,
 * communicating via IPC for job events.
 */

import { fork, type ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { watch } from 'fs';
import { jobEvents, type JobEvent } from '../sync/queue.js';
import { logger } from '../logger.js';
import type { Config } from '../config.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Accumulate diffs for this interval before sending to child
const DIFF_ACCUMULATE_MS = 100;

// ============================================================================
// Auth Status Types
// ============================================================================

export type AuthStatus = 'pending' | 'authenticating' | 'authenticated' | 'failed';

export interface AuthStatusUpdate {
  status: AuthStatus;
  username?: string;
}

// ============================================================================
// Diff Types - Accumulated changes to send to frontend
// ============================================================================

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

/** Accumulated changes to send to frontend */
export interface DashboardDiff {
  /** Stats deltas: positive = increment, negative = decrement */
  statsDelta: {
    pending: number;
    processing: number;
    synced: number;
    blocked: number;
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

/** Create an empty diff */
function createEmptyDiff(): DashboardDiff {
  return {
    statsDelta: { pending: 0, processing: 0, synced: 0, blocked: 0 },
    addProcessing: [],
    removeProcessing: [],
    addRecent: [],
    addBlocked: [],
  };
}

/** Check if a diff has any changes worth sending */
function hasDiffChanges(diff: DashboardDiff): boolean {
  return (
    diff.statsDelta.pending !== 0 ||
    diff.statsDelta.processing !== 0 ||
    diff.statsDelta.synced !== 0 ||
    diff.statsDelta.blocked !== 0 ||
    diff.addProcessing.length > 0 ||
    diff.removeProcessing.length > 0 ||
    diff.addRecent.length > 0 ||
    diff.addBlocked.length > 0
  );
}

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
      accumulatedDiff.removeProcessing.push(event.jobId);
      break;
  }
}

// ============================================================================
// Server Management
// ============================================================================

let dashboardProcess: ChildProcess | null = null;
let jobEventHandler: ((event: JobEvent) => void) | null = null;
let accumulatedDiff: DashboardDiff = createEmptyDiff();
let diffTimeout: ReturnType<typeof setTimeout> | null = null;
let fileWatcher: ReturnType<typeof watch> | null = null;
let currentConfig: Config | null = null;
let currentDryRun = false;
let currentAuthStatus: AuthStatusUpdate = { status: 'pending' };

/**
 * Start the dashboard in a separate process.
 */
export function startDashboard(config: Config, dryRun = false): void {
  if (dashboardProcess) {
    logger.warn('Dashboard process already running');
    return;
  }

  // Store config for potential restarts
  currentConfig = config;
  currentDryRun = dryRun;

  logger.debug(`Dashboard starting with dryRun=${dryRun}`);

  // Determine if we're running in dev mode (set by Makefile)
  const isDevMode = process.env.PROTON_DEV === '1';

  // Fork the dashboard subprocess
  // In dev mode, use tsx to run the TypeScript source directly for hot reload
  if (isDevMode) {
    const mainPath = join(__dirname, 'main.tsx');
    dashboardProcess = fork(mainPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: ['--import', 'tsx'],
    });
  } else {
    const mainPath = join(__dirname, 'main.js');
    dashboardProcess = fork(mainPath, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  }

  // Handle messages from child
  dashboardProcess.on('message', (msg: { type: string; port?: number }) => {
    if (msg.type === 'ready') {
      const hotReloadMsg = isDevMode ? ' (hot reload enabled)' : '';
      logger.info(`Dashboard running at http://localhost:${msg.port}${hotReloadMsg}`);

      // Send current auth status when dashboard is ready
      if (dashboardProcess?.connected) {
        dashboardProcess.send({ type: 'auth', ...currentAuthStatus });
      }
    }
  });

  // Handle child process errors
  dashboardProcess.on('error', (err) => {
    logger.error(`Dashboard process error: ${err.message}`);
  });

  // Handle child process exit
  dashboardProcess.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      logger.warn(`Dashboard process exited with code ${code}, signal ${signal}`);
    }
    dashboardProcess = null;
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }
  });

  // Send initial config
  dashboardProcess.send({ type: 'config', config, dryRun });

  // Forward job events to child process via IPC (accumulated into diffs)
  jobEventHandler = (event: JobEvent) => {
    if (!dashboardProcess?.connected) return;

    // Accumulate the event into the diff based on event type
    accumulateEvent(event);

    // Schedule sending the diff if not already scheduled
    if (!diffTimeout) {
      diffTimeout = setTimeout(() => {
        diffTimeout = null;
        if (dashboardProcess?.connected && hasDiffChanges(accumulatedDiff)) {
          dashboardProcess.send({ type: 'job_state_diff', diff: accumulatedDiff });
          accumulatedDiff = createEmptyDiff();
        }
      }, DIFF_ACCUMULATE_MS);
    }
  };
  jobEvents.on('job', jobEventHandler);

  // Watch for source file changes in development
  if (isDevMode) {
    setupHotReload();
  }
}

/**
 * Stop the dashboard process.
 */
export function stopDashboard(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }

  if (dashboardProcess) {
    // Remove event listener
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }

    // Gracefully terminate the child process
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
    logger.debug('Dashboard process stopped');
  }
}

/**
 * Set up hot reload for dashboard in development mode.
 * Watches the dashboard source directory and restarts the subprocess on changes.
 */
function setupHotReload(): void {
  // When running with tsx, __dirname is src/dashboard, otherwise dist/dashboard
  // We want to watch the source directory for changes
  const dashboardDir = __dirname.includes('dist')
    ? __dirname.replace('/dist/', '/src/')
    : __dirname;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  logger.info(`Dashboard hot reload enabled, watching ${dashboardDir}`);

  fileWatcher = watch(dashboardDir, { recursive: true }, (eventType, filename) => {
    if (
      !filename ||
      (!filename.endsWith('.ts') && !filename.endsWith('.tsx') && !filename.endsWith('.html'))
    ) {
      return;
    }

    // Debounce rapid changes
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      logger.info(`Dashboard source changed (${filename}), restarting...`);
      restartDashboard();
    }, 500);
  });
}

/**
 * Restart the dashboard subprocess (used for hot reload).
 */
function restartDashboard(): void {
  if (!currentConfig) return;

  // Stop current process
  if (dashboardProcess) {
    if (jobEventHandler) {
      jobEvents.off('job', jobEventHandler);
      jobEventHandler = null;
    }
    dashboardProcess.kill('SIGTERM');
    dashboardProcess = null;
  }

  // Wait a bit for the process to terminate, then restart
  setTimeout(() => {
    if (currentConfig) {
      // Temporarily clear fileWatcher to avoid re-setting up
      const savedWatcher = fileWatcher;
      fileWatcher = null;
      startDashboard(currentConfig, currentDryRun);
      fileWatcher = savedWatcher;
    }
  }, 100);
}

/**
 * Send auth status update to the dashboard process.
 */
export function sendAuthStatus(update: AuthStatusUpdate): void {
  // Store current auth status for hot reload
  currentAuthStatus = update;
  if (dashboardProcess?.connected) {
    dashboardProcess.send({ type: 'auth', ...update });
  }
}
