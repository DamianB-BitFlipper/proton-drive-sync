/**
 * Dashboard Subprocess Entry Point
 *
 * This file runs as a separate Node.js process, forked from the main sync process.
 * It communicates with the parent via IPC for job events (received as diffs).
 *
 * Uses htmx with SSE - sends HTML fragments for live updates.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { createReadStream, statSync, watchFile, unwatchFile, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { xdgState } from 'xdg-basedir';
import { EventEmitter } from 'events';
import {
  getJobCounts,
  getRecentJobs,
  getBlockedJobs,
  getProcessingJobs,
  getPendingJobs,
  getRetryJobs,
  retryAllNow,
} from '../sync/queue.js';
import { FLAGS, setFlag, clearFlag, hasFlag } from '../flags.js';
import { sendSignal } from '../signals.js';
import { logger } from '../logger.js';
import { CONFIG_FILE, CONFIG_CHECK_SIGNAL } from '../config.js';
import {
  isServiceInstalled,
  loadSyncService,
  unloadSyncService,
  serviceInstallCommand,
} from '../cli/service.js';
import type {
  DashboardDiff,
  AuthStatusUpdate,
  DashboardJob,
  DashboardStatus,
  SyncStatus,
} from './server.js';
import type { Config } from '../config.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_PORT = 4242;
const LOG_FILE = join(xdgState || '', 'proton-drive-sync', 'sync.log');

// Store initial log position at subprocess startup (so refreshes get all session logs)
let initialLogPosition = 0;
try {
  initialLogPosition = statSync(LOG_FILE).size;
} catch {
  // File doesn't exist yet
}

// ============================================================================
// IPC Event Bridge
// ============================================================================

// Local event emitter to bridge IPC messages to SSE streams
const stateDiffEvents = new EventEmitter();
const statusEvents = new EventEmitter();
const heartbeatEvents = new EventEmitter();

// Current status (for API endpoint)
let currentAuthStatus: AuthStatusUpdate = { status: 'unauthenticated' };
let currentSyncStatus: SyncStatus = 'disconnected';
let currentConfig: Config | null = null;
let loggedAuthUser: string | null = null; // Track logged auth to avoid duplicate logs

// Listen for diff events from parent process via IPC
process.on(
  'message',
  (msg: {
    type: string;
    diff?: DashboardDiff;
    dryRun?: boolean;
    config?: Config;
    auth?: AuthStatusUpdate;
    syncStatus?: SyncStatus;
  }) => {
    if (msg.type === 'job_state_diff' && msg.diff) {
      stateDiffEvents.emit('job_state_diff', msg.diff);
    } else if (msg.type === 'config') {
      if (msg.dryRun !== undefined) isDryRun = msg.dryRun;
      if (msg.config) currentConfig = msg.config;
    } else if (msg.type === 'status') {
      if (msg.auth) {
        currentAuthStatus = msg.auth;
      }
      if (msg.syncStatus !== undefined) {
        currentSyncStatus = msg.syncStatus;
      }
      statusEvents.emit('status', {
        auth: currentAuthStatus,
        syncStatus: currentSyncStatus,
      });
    } else if (msg.type === 'heartbeat') {
      heartbeatEvents.emit('heartbeat');
    }
  }
);

// ============================================================================
// HTML Fragment Renderers
// ============================================================================

function formatPath(path: string): string {
  return basename(path);
}

function formatTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleTimeString();
}

/** Render stats cards HTML */
function renderStats(counts: {
  pending: number;
  processing: number;
  synced: number;
  blocked: number;
}): string {
  return `
<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
  <!-- Pending -->
  <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-amber-500/50 transition-colors group relative overflow-hidden">
    <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
      <svg class="w-12 h-12 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
    <dt class="text-sm font-medium text-gray-400">Pending</dt>
    <dd class="mt-2 text-3xl font-bold text-white group-hover:text-amber-400 transition-colors">${counts.pending}</dd>
  </div>

  <!-- Processing -->
  <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-blue-500/50 transition-colors group relative overflow-hidden">
    <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
      <svg class="w-12 h-12 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
    </div>
    <dt class="text-sm font-medium text-gray-400">Processing</dt>
    <dd class="mt-2 text-3xl font-bold text-white group-hover:text-blue-400 transition-colors">${counts.processing}</dd>
  </div>

  <!-- Synced -->
  <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-green-500/50 transition-colors group relative overflow-hidden">
    <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
      <svg class="w-12 h-12 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
      </svg>
    </div>
    <dt class="text-sm font-medium text-gray-400">Synced</dt>
    <dd class="mt-2 text-3xl font-bold text-white group-hover:text-green-400 transition-colors">${counts.synced}</dd>
  </div>

  <!-- Blocked -->
  <div class="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-sm hover:border-red-500/50 transition-colors group relative overflow-hidden">
    <div class="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
      <svg class="w-12 h-12 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    </div>
    <dt class="text-sm font-medium text-gray-400">Blocked</dt>
    <dd class="mt-2 text-3xl font-bold text-white group-hover:text-red-400 transition-colors">${counts.blocked}</dd>
  </div>
</div>`;
}

/** Render processing queue HTML (header with pause button + list) */
function renderProcessingQueue(jobs: DashboardJob[]): string {
  const isPaused = currentSyncStatus === 'paused';

  const header = `
<div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl">
  <h2 id="processing-title" class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2" sse-swap="processing-title" hx-swap="innerHTML">
    <span class="w-2 h-2 rounded-full ${isPaused ? 'bg-amber-500' : 'bg-blue-500 animate-pulse'}"></span>
    ${isPaused ? 'Paused' : 'Active Transfers'}
  </h2>
  <div class="flex items-center gap-3">
    <div id="pause-button">${renderPauseButton(currentSyncStatus)}</div>
    <span class="text-xs font-mono text-gray-500">${jobs.length} items</span>
  </div>
</div>`;

  const listContent =
    jobs.length === 0
      ? `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
  <p class="text-sm">Queue is empty</p>
</div>`
      : (() => {
          const isActive =
            currentSyncStatus === 'syncing' && currentAuthStatus.status === 'authenticated';
          const icon = isActive
            ? `<svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>`
            : `<svg class="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>`;

          return `<div class="space-y-1">${jobs
            .map(
              (job) => `
<div class="px-3 py-2.5 rounded-lg bg-gray-900/50 border border-gray-700/50 hover:border-blue-500/30 transition-colors group">
  <div class="flex items-start gap-3">
    ${icon}
    <div class="min-w-0 flex-1">
      <div class="text-xs font-mono text-gray-300 truncate">${escapeHtml(formatPath(job.localPath))}</div>
      <div class="text-[10px] text-gray-500 mt-0.5 truncate">${escapeHtml(job.localPath)}</div>
    </div>
  </div>
</div>`
            )
            .join('')}</div>`;
        })();

  const list = `<div class="flex-1 overflow-y-auto custom-scrollbar p-2">${listContent}</div>`;

  return header + list;
}

/** Render blocked queue HTML (header + list) */
function renderBlockedQueue(jobs: DashboardJob[]): string {
  const header = `
<div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl min-h-[56px]">
  <h2 class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-red-500"></span>
    Failed Transfers
  </h2>
  <div class="flex items-center gap-3">
    <div class="h-7"></div>
    <span class="text-xs font-mono text-gray-500">${jobs.length} items</span>
  </div>
</div>`;

  const listContent =
    jobs.length === 0
      ? `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <p class="text-sm">All systems nominal</p>
</div>`
      : `<div class="space-y-1">${jobs
          .map(
            (job) => `
<div class="px-3 py-2.5 rounded-lg bg-red-500/5 border border-red-500/20 hover:bg-red-500/10 transition-colors group">
  <div class="flex items-start gap-3">
    <svg class="w-4 h-4 text-red-500 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
    <div class="min-w-0 flex-1">
      <div class="text-xs font-mono text-red-200 truncate">${escapeHtml(formatPath(job.localPath))}</div>
      <div class="text-[10px] text-red-400/70 mt-1 line-clamp-2">${escapeHtml(job.lastError || '')}</div>
    </div>
    <div class="shrink-0 text-[10px] font-mono text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded border border-red-500/20">
      Retry: ${job.nRetries || 0}
    </div>
  </div>
</div>`
          )
          .join('')}</div>`;

  const list = `<div class="flex-1 overflow-y-auto custom-scrollbar p-2">${listContent}</div>`;

  return header + list;
}

/** Render recent queue HTML (header + list) */
function renderRecentQueue(jobs: DashboardJob[]): string {
  const header = `
<div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl min-h-[56px]">
  <h2 class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-green-500"></span>
    Recently Synced
  </h2>
  <div class="flex items-center gap-3">
    <div class="h-7"></div>
    <span class="text-xs font-mono text-gray-500">${jobs.length} items</span>
  </div>
</div>`;

  const listContent =
    jobs.length === 0
      ? `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <p class="text-sm">No recent activity</p>
</div>`
      : `<div class="space-y-1">${jobs
          .map(
            (job) => `
<div class="px-3 py-2 rounded-lg hover:bg-gray-700/50 transition-colors flex items-center gap-3">
  <svg class="w-4 h-4 text-green-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
  </svg>
  <div class="min-w-0 flex-1 flex items-center justify-between gap-4">
    <span class="text-xs font-mono text-gray-300 truncate">${escapeHtml(formatPath(job.localPath))}</span>
    <span class="text-[10px] text-gray-500 font-mono whitespace-nowrap">${formatTime(job.createdAt)}</span>
  </div>
</div>`
          )
          .join('')}</div>`;

  const list = `<div class="flex-1 overflow-y-auto custom-scrollbar p-2">${listContent}</div>`;

  return header + list;
}

/** Render pending queue HTML (header + list) */
function renderPendingQueue(jobs: DashboardJob[]): string {
  const header = `
<div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl">
  <h2 class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-amber-500"></span>
    Pending
  </h2>
  <div class="flex items-center gap-3">
    <div class="h-7"></div>
    <span class="text-xs font-mono text-gray-500">${jobs.length} items</span>
  </div>
</div>`;

  const listContent =
    jobs.length === 0
      ? `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <p class="text-sm">Queue empty</p>
</div>`
      : `<div class="space-y-1">${jobs
          .map(
            (job) => `
<div class="px-3 py-2 rounded-lg hover:bg-gray-700/50 transition-colors flex items-center gap-3">
  <svg class="w-4 h-4 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <div class="min-w-0 flex-1">
    <span class="text-xs font-mono text-gray-300 truncate block">${escapeHtml(formatPath(job.localPath))}</span>
  </div>
</div>`
          )
          .join('')}</div>`;

  const list = `<div class="flex-1 overflow-y-auto custom-scrollbar p-2">${listContent}</div>`;

  return header + list;
}

/** Render retry queue HTML (header with button + list) */
function renderRetryQueue(jobs: DashboardJob[]): string {
  const retryAllButton =
    jobs.length > 0
      ? `
<button
  hx-post="/api/signal/retry-all-now"
  hx-target="#retry-queue"
  hx-swap="innerHTML"
  class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-orange-500/30 hover:border-orange-500/50 hover:bg-orange-500/10 transition-colors cursor-pointer"
>
  <svg class="h-3 w-3 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
  <span class="text-xs font-medium text-orange-400">Retry All Now</span>
</button>`
      : '';

  const header = `
<div class="px-5 py-4 border-b border-gray-700 flex justify-between items-center bg-gray-800/50 backdrop-blur rounded-t-xl min-h-[56px]">
  <h2 class="text-sm font-semibold text-gray-100 uppercase tracking-wider flex items-center gap-2">
    <span class="w-2 h-2 rounded-full bg-orange-500"></span>
    Retry Queue
  </h2>
  <div class="flex items-center gap-3">
    ${retryAllButton || '<div class="h-7"></div>'}
    <span class="text-xs font-mono text-gray-500">${jobs.length} items</span>
  </div>
</div>`;

  const listContent =
    jobs.length === 0
      ? `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <p class="text-sm">No scheduled retries</p>
</div>`
      : `<div class="space-y-1">${jobs
          .map((job) => {
            const retryAtIso = job.retryAt
              ? typeof job.retryAt === 'string'
                ? job.retryAt
                : job.retryAt.toISOString()
              : '';
            return `
<div class="px-3 py-2 rounded-lg hover:bg-gray-700/50 transition-colors flex items-center gap-3">
  <svg class="w-4 h-4 text-orange-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
  <div class="min-w-0 flex-1 flex items-center justify-between gap-4">
    <span class="text-xs font-mono text-gray-300 truncate">${escapeHtml(formatPath(job.localPath))}</span>
    <span class="text-[10px] text-orange-400 font-mono whitespace-nowrap retry-countdown" data-retry-at="${retryAtIso}"></span>
  </div>
</div>`;
          })
          .join('')}</div>`;

  const list = `<div class="flex-1 overflow-y-auto custom-scrollbar p-2">${listContent}</div>`;

  return header + list;
}

/** Render auth status HTML */
function renderAuthStatus(auth: AuthStatusUpdate): string {
  const statusConfig = {
    unauthenticated: {
      border: 'border-gray-500/30 bg-gray-500/10',
      icon: `<svg class="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
      text: 'text-gray-400',
      label: 'Not authenticated',
    },
    authenticating: {
      border: 'border-amber-500/30 bg-amber-500/10',
      icon: `<svg class="animate-spin h-3 w-3 text-amber-400" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>`,
      text: 'text-amber-400',
      label: 'Authenticating...',
    },
    authenticated: {
      border: 'border-green-500/30 bg-green-500/10',
      icon: `<svg class="h-3 w-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" /></svg>`,
      text: 'text-green-400',
      label: '', // Set below after status check
    },
    failed: {
      border: 'border-red-500/30 bg-red-500/10',
      icon: `<svg class="h-3 w-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" /></svg>`,
      text: 'text-red-400',
      label: 'Auth Failed',
    },
  };

  // Set authenticated label only when status is authenticated (to safely access username)
  if (auth.status === 'authenticated') {
    const label = auth.username ? `${auth.username}@proton.me` : 'Logged in';
    statusConfig.authenticated.label = label;
    if (loggedAuthUser !== label) {
      loggedAuthUser = label;
      logger.info(`Authenticated as ${label}`);
    }
  }

  const config = statusConfig[auth.status] || statusConfig.unauthenticated;
  return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full border ${config.border}">
  ${config.icon}
  <span class="text-xs font-medium ${config.text}">${config.label}</span>
</div>`;
}

/** Render stop section HTML - returns empty string when disconnected */
function renderStopSection(syncStatus: string): string {
  if (syncStatus === 'disconnected') return '';

  return `
<div class="bg-gray-800 rounded-xl border border-gray-700 p-6">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h3 class="text-lg font-semibold text-white">Stop Proton Drive Sync</h3>
      <div class="relative group flex items-center">
        <i data-lucide="info" class="w-4 h-4 text-gray-500 cursor-help"></i>
        <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-96 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
          You can start it again with <code class="bg-gray-800 px-1 py-0.5 rounded font-mono">proton-drive-sync start</code>
        </div>
      </div>
    </div>
    <button
      onclick="stopService()"
      id="stop-button"
      class="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
    >
      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
      Stop
    </button>
  </div>
</div>`;
}

/** Render paused badge HTML - only shown when paused */
function renderPausedBadge(isPaused: boolean): string {
  if (!isPaused) return '';
  return `
<div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-amber-500/30 bg-amber-500/10">
  <svg class="h-3 w-3 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <span class="text-xs font-medium text-amber-400">Paused</span>
</div>`;
}

/** Render syncing status badge HTML */
function renderSyncingBadge(syncStatus: SyncStatus): string {
  if (syncStatus === 'syncing') {
    return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full bg-gray-900 border border-green-500/30 bg-green-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
  </div>
  <span class="text-xs font-medium text-green-400">Connected</span>
</div>`;
  }
  if (syncStatus === 'paused') {
    return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full bg-gray-900 border border-amber-500/30 bg-amber-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
  </div>
  <span class="text-xs font-medium text-amber-400">Paused</span>
</div>`;
  }
  // disconnected
  return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full bg-gray-900 border border-red-500/30 bg-red-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
  </div>
  <span class="text-xs font-medium text-red-400">Disconnected</span>
</div>`;
}

/** Render pause/resume button (hidden when disconnected) */
function renderPauseButton(syncStatus: SyncStatus): string {
  if (syncStatus === 'disconnected') {
    return '<div id="pause-button" class="h-7"></div>';
  }
  if (syncStatus === 'paused') {
    // Show resume button
    return `
<button
  id="pause-button"
  hx-post="/api/toggle-pause"
  hx-swap="outerHTML"
  class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-green-500/30 hover:border-green-500/50 hover:bg-green-500/10 transition-colors cursor-pointer"
>
  <svg class="h-3 w-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <span class="text-xs font-medium text-green-400">Resume Sync</span>
</button>`;
  }
  // Show pause button (syncing state)
  return `
<button
  id="pause-button"
  hx-post="/api/toggle-pause"
  hx-swap="outerHTML"
  class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-gray-600 hover:border-amber-500/50 hover:bg-amber-500/10 transition-colors cursor-pointer"
>
  <svg class="h-3 w-3 text-gray-400 hover:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <span class="text-xs font-medium text-gray-400">Pause Sync</span>
</button>`;
}

/** Render dry-run banner HTML */
function renderDryRunBanner(dryRun: boolean): string {
  if (!dryRun) return '';
  return `
<div class="bg-amber-500/90 text-amber-950 px-4 py-2.5 text-center font-medium text-sm shadow-lg">
  <div class="flex items-center justify-center gap-2">
    <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
    <span>DRY-RUN MODE - No changes are being synced. Information shown may be incorrect.</span>
  </div>
</div>`;
}

/** Render processing box title based on pause state, auth status, and syncing status */
function renderProcessingTitle(isPaused: boolean): string {
  if (currentAuthStatus.status !== 'authenticated' || currentSyncStatus !== 'syncing') {
    return `
<span class="w-2 h-2 rounded-full bg-amber-500"></span>
Held Transfers
<div class="relative group">
  <i data-lucide="info" class="w-4 h-4 text-gray-500 cursor-help"></i>
  <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-80 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10 normal-case font-normal">
    Transfers are held until you authenticate and syncing starts
  </div>
</div>`;
  }
  if (isPaused) {
    return `
<span class="w-2 h-2 rounded-full bg-amber-500"></span>
Paused Transfers`;
  }
  return `
<span class="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
Active Transfers`;
}

/** Render a single log line as HTML */
function renderLogLine(line: string): string {
  let level = 20;
  let levelClass = 'border-gray-700 text-gray-500';
  let formattedLine = line;

  if (line.includes('"level":50') || line.includes('"level":"error"')) {
    level = 50;
    levelClass = 'border-red-500/50 bg-red-500/5 text-red-200';
  } else if (line.includes('"level":40') || line.includes('"level":"warn"')) {
    level = 40;
    levelClass = 'border-amber-500/50 bg-amber-500/5 text-amber-200';
  } else if (line.includes('"level":30') || line.includes('"level":"info"')) {
    level = 30;
    levelClass = 'border-blue-500/50 text-blue-200';
  }

  try {
    const json = JSON.parse(line);
    const time = new Date(json.time || json.timestamp).toLocaleTimeString();
    formattedLine = `[${time}] ${json.msg || json.message}`;
  } catch {
    // Use raw line if not valid JSON
  }

  return `<div data-level="${level}" class="break-all border-l-2 pl-3 py-0.5 ${levelClass}">${escapeHtml(formattedLine)}</div>`;
}

/** Escape HTML entities */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Render config info HTML */
function renderConfigInfo(config: Config | null): string {
  if (!config) return '';

  return `
  <div class="flex flex-wrap gap-3 max-h-24 overflow-y-auto custom-scrollbar p-1">
  ${config.sync_dirs
    .map((dir) => {
      const folderName = basename(dir.source_path);
      const remotePath =
        dir.remote_root === '/' ? `/${folderName}` : `${dir.remote_root}/${folderName}`;
      return `
    <div class="flex items-center gap-2 px-3 py-1.5 bg-gray-900 border border-gray-700 rounded-md shadow-sm group hover:border-gray-600 transition-colors">
      <div class="flex items-center gap-2">
        <svg class="w-3.5 h-3.5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span class="font-mono text-xs text-gray-300">${escapeHtml(dir.source_path)}</span>
      </div>
      
      <svg class="w-3 h-3 text-gray-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>

      <div class="flex items-center gap-2">
        <svg class="w-3.5 h-3.5 text-indigo-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
        </svg>
        <span class="font-mono text-xs text-indigo-300">${escapeHtml(remotePath)}</span>
      </div>
    </div>`;
    })
    .join('')}
  </div>`;
}

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();
let isDryRun = false;

// Page-specific scripts
const HOME_PAGE_SCRIPTS = `
<script>
  // Log level filtering
  let currentLogLevel = 20;
  
  function setLogLevel(level) {
    currentLogLevel = level;
    // Update button styles
    [20, 30, 40, 50].forEach(l => {
      const btn = document.getElementById('log-level-' + l);
      if (btn) {
        if (l === level) {
          btn.className = 'px-2 py-0.5 text-[10px] font-medium rounded transition-all duration-200 bg-gray-700 text-gray-200 shadow-sm';
        } else {
          btn.className = 'px-2 py-0.5 text-[10px] font-medium rounded transition-all duration-200 text-gray-500 hover:text-gray-400 hover:bg-gray-800/50';
        }
      }
    });
    // Filter log lines
    document.querySelectorAll('#logs-container > div[data-level]').forEach(el => {
      const logLevel = parseInt(el.getAttribute('data-level') || '0');
      el.style.display = logLevel >= level ? '' : 'none';
    });
  }

  // Apply filter to new log lines as they arrive
  const logsContainer = document.getElementById('logs-container');
  if (logsContainer) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1 && node.hasAttribute('data-level')) {
            const logLevel = parseInt(node.getAttribute('data-level') || '0');
            node.style.display = logLevel >= currentLogLevel ? '' : 'none';
          }
        });
      });
    });
    observer.observe(logsContainer, { childList: true });
  }

  // Retry countdown timer
  function updateRetryCountdowns() {
    document.querySelectorAll('.retry-countdown').forEach(el => {
      const retryAt = el.getAttribute('data-retry-at');
      if (!retryAt) return;
      const retryTime = new Date(retryAt).getTime();
      const now = Date.now();
      const diffMs = retryTime - now;
      if (diffMs <= 0) {
        el.textContent = 'now';
      } else {
        const totalSecs = Math.ceil(diffMs / 1000);
        const days = Math.floor(totalSecs / 86400);
        const hours = Math.floor((totalSecs % 86400) / 3600);
        const mins = Math.floor((totalSecs % 3600) / 60);
        const secs = totalSecs % 60;
        let text = 'in ';
        if (days > 0) text += days + 'd ';
        if (hours > 0) text += hours + 'h ';
        if (mins > 0) text += mins + 'm ';
        if (secs > 0 || totalSecs === 0) text += secs + 's';
        el.textContent = text.trim();
      }
    });
  }
  setInterval(updateRetryCountdowns, 1000);
  updateRetryCountdowns();

  // Re-initialize Lucide icons after SSE updates
  document.body.addEventListener('htmx:afterSwap', (e) => {
    lucide.createIcons();
    updateRetryCountdowns();
  });
  document.body.addEventListener('htmx:sseMessage', () => {
    lucide.createIcons();
  });
</script>`;

const SETTINGS_PAGE_SCRIPTS = `
<script>
  let syncDirs = [];
  let originalConfig = null;
  let serviceEnabled = false;
  const redirectAfterSave = '{{REDIRECT_AFTER_SAVE}}';

  // Load current config and service status on page load
  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      const config = data.config;
      originalConfig = JSON.parse(JSON.stringify(config));

      document.getElementById('sync-concurrency').value = config.sync_concurrency || 8;
      document.getElementById('concurrency-value').textContent = config.sync_concurrency || 8;
      syncDirs = config.sync_dirs || [];
      renderSyncDirs();
    } catch (err) {
      console.error('Failed to load config:', err);
    }
  }

  async function loadServiceStatus() {
    try {
      const response = await fetch('/api/service-status');
      const data = await response.json();
      serviceEnabled = data.enabled;
      updateToggleUI();
    } catch (err) {
      console.error('Failed to load service status:', err);
    }
  }

  function updateToggleUI() {
    const toggle = document.getElementById('start-on-login-toggle');
    const knob = document.getElementById('start-on-login-knob');
    
    if (serviceEnabled) {
      toggle.classList.remove('bg-gray-600');
      toggle.classList.add('bg-proton');
      toggle.setAttribute('aria-checked', 'true');
      knob.classList.remove('translate-x-1');
      knob.classList.add('translate-x-6');
    } else {
      toggle.classList.remove('bg-proton');
      toggle.classList.add('bg-gray-600');
      toggle.setAttribute('aria-checked', 'false');
      knob.classList.remove('translate-x-6');
      knob.classList.add('translate-x-1');
    }
  }

  async function toggleStartOnLogin() {
    const toggle = document.getElementById('start-on-login-toggle');
    toggle.disabled = true;
    
    try {
      const response = await fetch('/api/toggle-service', { method: 'POST' });
      const data = await response.json();
      
      if (data.success) {
        serviceEnabled = data.enabled;
        updateToggleUI();
      }
    } catch (err) {
      console.error('Failed to toggle service:', err);
    } finally {
      toggle.disabled = false;
    }
  }

  function renderSyncDirs() {
    const container = document.getElementById('sync-dirs-list');
    const noMessage = document.getElementById('no-dirs-message');

    if (syncDirs.length === 0) {
      container.innerHTML = '';
      noMessage.classList.remove('hidden');
      return;
    }

    noMessage.classList.add('hidden');
    container.innerHTML = syncDirs
      .map(
        (dir, index) => \`
      <div class="flex items-center gap-3 p-4 bg-gray-900 border border-gray-700 rounded-lg group">
        <div class="flex-1 grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Local Path</label>
            <input
              type="text"
              value="\${escapeHtml(dir.source_path)}"
              onchange="updateSyncDir(\${index}, 'source_path', this.value)"
              placeholder="/path/to/local/directory"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
            />
          </div>
          <div>
            <div class="flex items-center gap-1 mb-1">
              <label class="block text-xs text-gray-500">Remote Root</label>
              <div class="relative group">
                <i data-lucide="info" class="w-3 h-3 text-gray-500 cursor-help"></i>
                <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-96 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                  The destination folder in Proton Drive. Must start with / indicating the base of the Proton Drive filesystem.
                </div>
              </div>
            </div>
            <input
              type="text"
              value="\${escapeHtml(dir.remote_root || '/')}"
              onchange="updateSyncDir(\${index}, 'remote_root', this.value)"
              placeholder="/"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
            />
          </div>
        </div>
        <button
          onclick="removeSyncDir(\${index})"
          class="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
          title="Remove directory"
        >
          <i data-lucide="trash-2" class="w-5 h-5"></i>
        </button>
      </div>
    \`
      )
      .join('');

    // Re-initialize Lucide icons for dynamically added content
    lucide.createIcons();
  }

  function addSyncDir() {
    syncDirs.push({ source_path: '', remote_root: '/' });
    renderSyncDirs();
  }

  function removeSyncDir(index) {
    syncDirs.splice(index, 1);
    renderSyncDirs();
  }

  function updateSyncDir(index, field, value) {
    if (field === 'remote_root') {
      const input = event.target;
      if (value && !value.startsWith('/')) {
        input.classList.add('border-red-500');
        input.setCustomValidity('Remote root must start with /');
        return;
      } else {
        input.classList.remove('border-red-500');
        input.setCustomValidity('');
      }
    }
    syncDirs[index][field] = value;
  }

  async function saveConfig() {
    const saveButton = document.getElementById('save-button');

    // Validate
    const validDirs = syncDirs.filter((d) => d.source_path.trim());
    if (validDirs.length === 0) {
      showToast('At least one sync directory is required', 'error', 5000);
      return;
    }

    const config = {
      sync_concurrency: parseInt(document.getElementById('sync-concurrency').value) || 8,
      sync_dirs: validDirs.map((d) => ({
        source_path: d.source_path.trim(),
        remote_root: d.remote_root?.trim() || '',
      })),
    };

    saveButton.disabled = true;

    try {
      const response = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });

      const result = await response.json();

      if (result.success) {
        showToast('Settings saved successfully!', 'success');
        // Redirect to about page after successful save only during onboarding
        if (redirectAfterSave) {
          window.location.href = redirectAfterSave;
        } else {
          originalConfig = JSON.parse(JSON.stringify(config));
          syncDirs = config.sync_dirs;
          renderSyncDirs();
        }
      } else {
        showToast(result.error || 'Failed to save settings', 'error', 5000);
      }
    } catch (err) {
      showToast('Error saving settings', 'error', 5000);
    } finally {
      saveButton.disabled = false;
    }
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function stopService() {
    const button = document.getElementById('stop-button');
    button.disabled = true;

    try {
      const response = await fetch('/api/signal/stop', { method: 'POST' });
      if (response.ok) {
        showToast('Service stopping...', 'info');
      } else {
        showToast('Failed to stop service', 'error', 5000);
        button.disabled = false;
      }
    } catch (err) {
      showToast('Error stopping service', 'error', 5000);
      button.disabled = false;
    }
  }

  // Load config and service status on page load
  loadConfig();
  loadServiceStatus();
</script>`;

/**
 * Compose a page by injecting content into the layout template
 */
async function composePage(
  layoutHtml: string,
  contentHtml: string,
  options: {
    title: string;
    activeTab: 'home' | 'controls' | 'about';
    pageScripts: string;
    isOnboarded?: boolean;
  }
): Promise<string> {
  const isOnboarded = options.isOnboarded ?? hasFlag(FLAGS.ONBOARDED);
  const homeTabClass =
    options.activeTab === 'home'
      ? 'text-white border-b-2 border-white'
      : 'text-gray-400 hover:text-white';
  const controlsTabClass =
    options.activeTab === 'controls'
      ? 'text-white border-b-2 border-white'
      : 'text-gray-400 hover:text-white';
  const aboutTabClass =
    options.activeTab === 'about'
      ? 'text-white border-b-2 border-white'
      : 'text-gray-400 hover:text-white';

  return layoutHtml
    .replace('{{TITLE}}', options.title)
    .replace('{{HOME_TAB_CLASS}}', homeTabClass)
    .replace('{{CONTROLS_TAB_CLASS}}', controlsTabClass)
    .replace('{{ABOUT_TAB_CLASS}}', aboutTabClass)
    .replace('{{HIDE_HOME_TAB}}', isOnboarded ? '' : 'hidden')
    .replace('{{HIDE_BADGES}}', options.activeTab === 'about' ? 'hidden' : '')
    .replace('{{CONTENT}}', contentHtml)
    .replace('{{PAGE_SCRIPTS}}', options.pageScripts);
}

// Cache layout template
let layoutHtml: string | null = null;

async function getLayout(): Promise<string> {
  if (!layoutHtml) {
    layoutHtml = await readFile(join(__dirname, 'layout.html'), 'utf-8');
  }
  return layoutHtml;
}

// Serve dashboard HTML at root
app.get('/', async (c) => {
  // Redirect to controls if not onboarded
  if (!hasFlag(FLAGS.ONBOARDED)) {
    return c.redirect('/controls');
  }
  const layout = await getLayout();
  const content = await readFile(join(__dirname, 'home.html'), 'utf-8');
  const html = await composePage(layout, content, {
    title: 'Proton Drive Sync',
    activeTab: 'home',
    pageScripts: HOME_PAGE_SCRIPTS,
  });
  return c.html(html);
});

// Serve controls page
app.get('/controls', async (c) => {
  const layout = await getLayout();
  let content = await readFile(join(__dirname, 'controls.html'), 'utf-8');
  const isOnboarding = !hasFlag(FLAGS.ONBOARDED);

  // Replace button text/icons based on onboarding state
  content = content
    .replace('{{SAVE_BUTTON_TEXT}}', isOnboarding ? 'Next' : 'Save')
    .replace('{{HIDE_CHECK_ICON}}', isOnboarding ? 'hidden' : '')
    .replace('{{HIDE_ARROW_ICON}}', isOnboarding ? '' : 'hidden');

  // Inject redirect URL into scripts
  const redirectUrl = isOnboarding ? '/about' : '';
  const scriptsWithRedirect = SETTINGS_PAGE_SCRIPTS.replace('{{REDIRECT_AFTER_SAVE}}', redirectUrl);

  const html = await composePage(layout, content, {
    title: 'Controls - Proton Drive Sync',
    activeTab: 'controls',
    pageScripts: scriptsWithRedirect,
    isOnboarded: !isOnboarding,
  });
  return c.html(html);
});

// Serve about page
app.get('/about', async (c) => {
  const layout = await getLayout();
  let content = await readFile(join(__dirname, 'about.html'), 'utf-8');
  // Inject version from package.json
  const pkg = JSON.parse(await readFile(join(__dirname, '../../package.json'), 'utf-8'));
  content = content.replace('{{VERSION}}', pkg.version);
  const isOnboarded = hasFlag(FLAGS.ONBOARDED);
  content = content.replace('{{HIDE_START_BUTTON}}', isOnboarded ? 'hidden' : '');
  const aboutPageScripts = `
<script>
  async function startUsing() {
    const button = document.getElementById('start-using-button');
    button.disabled = true;
    button.innerHTML = '<span class="animate-spin">⏳</span> Starting...';
    
    try {
      const response = await fetch('/api/onboard', { method: 'POST' });
      if (response.ok) {
        window.location.href = '/';
      } else {
        button.disabled = false;
        button.innerHTML = '<i data-lucide="rocket" class="w-5 h-5"></i> Start Using';
        lucide.createIcons();
      }
    } catch (err) {
      button.disabled = false;
      button.innerHTML = '<i data-lucide="rocket" class="w-5 h-5"></i> Start Using';
      lucide.createIcons();
    }
  }
</script>`;
  const html = await composePage(layout, content, {
    title: 'About - Proton Drive Sync',
    activeTab: 'about',
    pageScripts: aboutPageScripts,
    isOnboarded,
  });
  return c.html(html);
});

// Serve static assets
app.get('/assets/:filename', async (c) => {
  const filename = c.req.param('filename');
  const filePath = join(__dirname, 'assets', filename);
  try {
    const content = await readFile(filePath);
    const ext = filename.split('.').pop();
    const contentType =
      ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : 'application/octet-stream';
    return c.body(content, 200, { 'Content-Type': contentType });
  } catch {
    return c.notFound();
  }
});

// ============================================================================
// HTML Fragment Endpoints
// ============================================================================

app.get('/api/fragments/stats', (c) => {
  return c.html(renderStats(getJobCounts()));
});

app.get('/api/fragments/stop-section', (c) => {
  return c.html(renderStopSection(currentSyncStatus));
});

app.get('/api/fragments/processing-queue', (c) => {
  return c.html(renderProcessingQueue(getProcessingJobs()));
});

app.get('/api/fragments/blocked-queue', (c) => {
  return c.html(renderBlockedQueue(getBlockedJobs()));
});

app.get('/api/fragments/recent-queue', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderRecentQueue(getRecentJobs(limit)));
});

app.get('/api/fragments/pending-queue', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderPendingQueue(getPendingJobs(limit)));
});

app.get('/api/fragments/retry-queue', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderRetryQueue(getRetryJobs(limit)));
});

app.get('/api/fragments/auth-status', (c) => {
  return c.html(renderAuthStatus(currentAuthStatus));
});

app.get('/api/fragments/dry-run-banner', (c) => {
  return c.html(renderDryRunBanner(isDryRun));
});

app.get('/api/fragments/config-info', (c) => {
  return c.html(renderConfigInfo(currentConfig));
});

app.get('/api/fragments/pause-button', (c) => {
  return c.html(renderPauseButton(currentSyncStatus));
});

app.get('/api/fragments/syncing-status', (c) => {
  return c.html(renderSyncingBadge(currentSyncStatus));
});

/** Set onboarded flag */
app.post('/api/onboard', (c) => {
  setFlag(FLAGS.ONBOARDED);
  return c.json({ success: true });
});

/** Get service start-on-login status */
app.get('/api/service-status', (c) => {
  const installed = isServiceInstalled();
  const enabled = hasFlag(FLAGS.SERVICE_LOADED);
  return c.json({ installed, enabled });
});

/** Toggle service start-on-login */
app.post('/api/toggle-service', async (c) => {
  const isInstalled = isServiceInstalled();
  const isEnabled = hasFlag(FLAGS.SERVICE_LOADED);

  if (isEnabled) {
    // Disable: just unload, don't uninstall
    unloadSyncService();
    return c.json({ success: true, enabled: false });
  } else {
    // Enable: install if needed, then load
    if (!isInstalled) {
      const success = await serviceInstallCommand(false);
      return c.json({ success, enabled: success });
    } else {
      const success = loadSyncService();
      return c.json({ success, enabled: success });
    }
  }
});

/** Toggle pause state */
app.post('/api/toggle-pause', (c) => {
  const isPaused = currentSyncStatus === 'paused';
  if (isPaused) {
    clearFlag(FLAGS.PAUSED);
    sendSignal('resume-sync');
  } else {
    setFlag(FLAGS.PAUSED);
    sendSignal('pause-sync');
  }
  // Return the new button state (optimistic UI update for button only)
  // The badge will update via the heartbeat path when the engine responds
  return c.html(renderPauseButton(isPaused ? 'syncing' : 'paused'));
});

/** Handle signals from dashboard */
app.post('/api/signal/:signal', (c) => {
  const signal = c.req.param('signal');

  if (signal === 'retry-all-now') {
    retryAllNow();
    // Re-render the retry list (now empty) and pending list (now has the jobs)
    stateDiffEvents.emit('job_state_diff', {
      pending: getPendingJobs(50),
      processing: [],
      synced: [],
      blocked: [],
      retry: getRetryJobs(50),
    });
    return c.html(renderRetryQueue(getRetryJobs(50)));
  }

  if (signal === 'stop') {
    // Set sync status to disconnected before stopping so UI updates
    currentSyncStatus = 'disconnected';
    statusEvents.emit('status', {
      auth: currentAuthStatus,
      syncStatus: 'disconnected',
    });
    sendSignal('stop');
    return c.text('OK');
  }

  return c.text('Unknown signal', 400);
});

// ============================================================================
// JSON API Endpoints (kept for backwards compatibility)
// ============================================================================

app.get('/api/stats', (c) => {
  return c.json(getJobCounts());
});

app.get('/api/jobs/recent', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.json(getRecentJobs(limit));
});

app.get('/api/jobs/blocked', (c) => {
  return c.json(getBlockedJobs());
});

app.get('/api/jobs/processing', (c) => {
  return c.json(getProcessingJobs());
});

app.get('/api/config', (c) => {
  return c.json({ dryRun: isDryRun, config: currentConfig });
});

/** Save config and trigger reload */
app.post('/api/config', async (c) => {
  try {
    const body = await c.req.json();
    const newConfig: Config = {
      sync_dirs: body.sync_dirs || [],
      sync_concurrency: body.sync_concurrency || 1,
    };

    // Validate
    if (!Array.isArray(newConfig.sync_dirs)) {
      return c.json({ error: 'sync_dirs must be an array' }, 400);
    }
    if (typeof newConfig.sync_concurrency !== 'number' || newConfig.sync_concurrency < 1) {
      return c.json({ error: 'sync_concurrency must be a positive number' }, 400);
    }

    // Write to config file
    writeFileSync(CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');

    // Update local state
    currentConfig = newConfig;

    // Send signal to trigger config reload in sync process
    sendSignal(CONFIG_CHECK_SIGNAL);

    return c.json({ success: true, config: newConfig });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.get('/api/auth', (c) => {
  return c.json(currentAuthStatus);
});

// ============================================================================
// SSE Endpoints - Send HTML Fragments
// ============================================================================

// GET /api/events - SSE stream of HTML fragment updates
app.get('/api/events', async (c) => {
  return streamSSE(c, async (stream) => {
    // Track previous state to avoid unnecessary re-renders
    let lastProcessingJobIds: number[] = [];
    let lastSyncStatus: SyncStatus = currentSyncStatus;

    const stateDiffHandler = (_diff: DashboardDiff) => {
      // On any state change, send updated HTML fragments
      const counts = getJobCounts();
      const processingJobs = getProcessingJobs();

      stream.writeSSE({ event: 'stats', data: renderStats(counts) });

      // Only send processing-queue if the jobs actually changed
      const currentJobIds = processingJobs.map((j) => j.id).sort((a, b) => a - b);
      const jobsChanged =
        currentJobIds.length !== lastProcessingJobIds.length ||
        currentJobIds.some((id, i) => id !== lastProcessingJobIds[i]);

      if (jobsChanged) {
        lastProcessingJobIds = currentJobIds;
        stream.writeSSE({
          event: 'processing-queue',
          data: renderProcessingQueue(processingJobs),
        });
      }

      stream.writeSSE({ event: 'blocked-queue', data: renderBlockedQueue(getBlockedJobs()) });
      stream.writeSSE({ event: 'pending-queue', data: renderPendingQueue(getPendingJobs(50)) });
      stream.writeSSE({ event: 'recent-queue', data: renderRecentQueue(getRecentJobs(50)) });
      stream.writeSSE({ event: 'retry-queue', data: renderRetryQueue(getRetryJobs(50)) });
    };

    const statusHandler = (status: DashboardStatus) => {
      const isPaused = status.syncStatus === 'paused';
      // Forward full status: auth, paused badge, syncing badge, processing title
      stream.writeSSE({ event: 'auth', data: renderAuthStatus(status.auth) });
      stream.writeSSE({ event: 'paused', data: renderPausedBadge(isPaused) });
      stream.writeSSE({ event: 'syncing', data: renderSyncingBadge(status.syncStatus) });
      stream.writeSSE({ event: 'processing-title', data: renderProcessingTitle(isPaused) });
      stream.writeSSE({ event: 'stop-section', data: renderStopSection(status.syncStatus) });

      // Only re-render processing-queue if sync status changed (affects pause button)
      if (status.syncStatus !== lastSyncStatus) {
        lastSyncStatus = status.syncStatus;
        stream.writeSSE({
          event: 'processing-queue',
          data: renderProcessingQueue(getProcessingJobs()),
        });
        stream.writeSSE({ event: 'pending-queue', data: renderPendingQueue(getPendingJobs(50)) });
      }

      stream.writeSSE({ event: 'heartbeat', data: '' });
    };

    const heartbeatHandler = () => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    };

    stateDiffEvents.on('job_state_diff', stateDiffHandler);
    statusEvents.on('status', statusHandler);
    heartbeatEvents.on('heartbeat', heartbeatHandler);

    // Send full initial state on connection
    const counts = getJobCounts();
    const processingJobs = getProcessingJobs();
    const blockedJobs = getBlockedJobs(50);
    const pendingJobs = getPendingJobs(50);
    const recentJobs = getRecentJobs(50);
    const retryJobs = getRetryJobs(50);
    const isPaused = currentSyncStatus === 'paused';

    await stream.writeSSE({ event: 'stats', data: renderStats(counts) });
    await stream.writeSSE({ event: 'auth', data: renderAuthStatus(currentAuthStatus) });
    await stream.writeSSE({ event: 'paused', data: renderPausedBadge(isPaused) });
    await stream.writeSSE({ event: 'syncing', data: renderSyncingBadge(currentSyncStatus) });
    await stream.writeSSE({ event: 'pause-button', data: renderPauseButton(currentSyncStatus) });
    await stream.writeSSE({
      event: 'processing-title',
      data: renderProcessingTitle(isPaused),
    });
    await stream.writeSSE({
      event: 'processing-queue',
      data: renderProcessingQueue(processingJobs),
    });
    await stream.writeSSE({ event: 'blocked-queue', data: renderBlockedQueue(blockedJobs) });
    await stream.writeSSE({ event: 'pending-queue', data: renderPendingQueue(pendingJobs) });
    await stream.writeSSE({ event: 'recent-queue', data: renderRecentQueue(recentJobs) });
    await stream.writeSSE({ event: 'retry-queue', data: renderRetryQueue(retryJobs) });
    await stream.writeSSE({ event: 'stop-section', data: renderStopSection(currentSyncStatus) });

    // Cleanup on close
    stream.onAbort(() => {
      stateDiffEvents.off('job_state_diff', stateDiffHandler);
      statusEvents.off('status', statusHandler);
      heartbeatEvents.off('heartbeat', heartbeatHandler);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// GET /api/logs - SSE stream of log lines as HTML
app.get('/api/logs', async (c) => {
  return streamSSE(c, async (stream) => {
    // Start from where the log file was when dashboard subprocess started
    let currentPosition = initialLogPosition;

    const sendNewLines = async () => {
      try {
        const stats = statSync(LOG_FILE);
        if (stats.size <= currentPosition) {
          if (stats.size < currentPosition) {
            currentPosition = 0; // Reset if truncated (log rotation)
          }
          return;
        }

        const readStream = createReadStream(LOG_FILE, {
          start: currentPosition,
          end: stats.size - 1,
        });

        const rl = createInterface({ input: readStream });

        for await (const line of rl) {
          if (line.trim()) {
            await stream.writeSSE({
              event: 'log',
              data: renderLogLine(line),
            });
          }
        }

        currentPosition = stats.size;
      } catch {
        // Ignore errors (file might not exist yet)
      }
    };

    // Send all logs from startup immediately
    await sendNewLines();

    const onFileChange = () => {
      sendNewLines();
    };

    watchFile(LOG_FILE, { interval: 500 }, onFileChange);

    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    }, 30000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      unwatchFile(LOG_FILE, onFileChange);
    });

    await new Promise(() => {});
  });
});

// ============================================================================
// Start Server
// ============================================================================

// Only start the server if this file is being run as a forked subprocess (with IPC channel)
// This prevents the server from starting when bun --watch scans/loads the file directly
const isForkedSubprocess = typeof process.send === 'function';

if (isForkedSubprocess) {
  const server = serve({
    fetch: app.fetch,
    port: DASHBOARD_PORT,
  });

  /**
   * Safely send IPC message to parent process.
   * If the parent has exited, the send will fail with EPIPE - we handle this gracefully.
   */
  function safeSend(message: Record<string, unknown>): void {
    if (process.send) {
      try {
        process.send(message);
      } catch {
        // Parent process has exited, shut down gracefully
        server.close();
        process.exit(0);
      }
    }
  }

  // Handle server errors (e.g., EADDRINUSE)
  server.on('error', (err: NodeJS.ErrnoException) => {
    safeSend({ type: 'error', error: err.message, code: err.code });
    process.exit(1);
  });

  // Wait for server to be listening before notifying parent
  server.on('listening', () => {
    safeSend({ type: 'ready', port: DASHBOARD_PORT });
  });

  // Graceful shutdown helper - exit immediately
  // SSE connections keep the server alive, so we can't wait for server.close()
  function shutdown() {
    process.exit(0);
  }

  // Exit if parent process dies (IPC channel closes)
  process.on('disconnect', shutdown);

  // Handle EPIPE errors from IPC when parent exits unexpectedly
  process.on('error', () => {
    shutdown();
  });

  // Graceful shutdown
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
