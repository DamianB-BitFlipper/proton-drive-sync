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
import { createReadStream, statSync, watchFile, unwatchFile } from 'fs';
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
import { FLAGS, setFlag, clearFlag } from '../flags.js';
import type { DashboardDiff, AuthStatusUpdate, DashboardJob, DashboardStatus } from './server.js';
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
let currentAuthStatus: AuthStatusUpdate = { status: 'pending' };
let currentIsPaused = false;
let currentConfig: Config | null = null;

// Listen for diff events from parent process via IPC
process.on(
  'message',
  (msg: {
    type: string;
    diff?: DashboardDiff;
    dryRun?: boolean;
    config?: Config;
    auth?: AuthStatusUpdate;
    isPaused?: boolean;
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
      if (msg.isPaused !== undefined) {
        currentIsPaused = msg.isPaused;
      }
      statusEvents.emit('status', { auth: currentAuthStatus, isPaused: currentIsPaused });
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

/** Render processing jobs list HTML */
function renderProcessingList(jobs: DashboardJob[]): string {
  if (jobs.length === 0) {
    return `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
  </svg>
  <p class="text-sm">Queue is empty</p>
</div>`;
  }

  return `<div class="space-y-1">${jobs
    .map(
      (job) => `
<div class="px-3 py-2.5 rounded-lg bg-gray-900/50 border border-gray-700/50 hover:border-blue-500/30 transition-colors group">
  <div class="flex items-start gap-3">
    <svg class="w-4 h-4 text-blue-500 mt-0.5 shrink-0 ${currentIsPaused ? '' : 'animate-spin'}" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
    <div class="min-w-0 flex-1">
      <div class="text-xs font-mono text-gray-300 truncate">${escapeHtml(formatPath(job.localPath))}</div>
      <div class="text-[10px] text-gray-500 mt-0.5 truncate">${escapeHtml(job.localPath)}</div>
    </div>
  </div>
</div>`
    )
    .join('')}</div>`;
}

/** Render blocked jobs list HTML */
function renderBlockedList(jobs: DashboardJob[]): string {
  if (jobs.length === 0) {
    return `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <svg class="w-10 h-10 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
  <p class="text-sm">All systems nominal</p>
</div>`;
  }

  return `<div class="space-y-1">${jobs
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
}

/** Render recent jobs list HTML */
function renderRecentList(jobs: DashboardJob[]): string {
  if (jobs.length === 0) {
    return `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <p class="text-sm">No recent activity</p>
</div>`;
  }

  return `<div class="space-y-1">${jobs
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
}

/** Render pending jobs list HTML */
function renderPendingList(jobs: DashboardJob[]): string {
  if (jobs.length === 0) {
    return `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <p class="text-sm">Queue empty</p>
</div>`;
  }

  return `<div class="space-y-1">${jobs
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
}

/** Format relative time for retry */
function formatRetryTime(date: Date | string | undefined): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  if (diffMs <= 0) return 'now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d`;
}

/** Render retry jobs list HTML */
function renderRetryList(jobs: DashboardJob[]): string {
  if (jobs.length === 0) {
    return `
<div class="h-full flex flex-col items-center justify-center text-gray-500 space-y-2">
  <p class="text-sm">No scheduled retries</p>
</div>`;
  }

  return `<div class="space-y-1">${jobs
    .map(
      (job) => `
<div class="px-3 py-2 rounded-lg hover:bg-gray-700/50 transition-colors flex items-center gap-3">
  <svg class="w-4 h-4 text-orange-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
  <div class="min-w-0 flex-1 flex items-center justify-between gap-4">
    <span class="text-xs font-mono text-gray-300 truncate">${escapeHtml(formatPath(job.localPath))}</span>
    <span class="text-[10px] text-orange-400 font-mono whitespace-nowrap">in ${formatRetryTime(job.retryAt)}</span>
  </div>
</div>`
    )
    .join('')}</div>`;
}

/** Render retry all now button - hidden when no retry jobs */
function renderRetryAllButton(shouldRender: boolean): string {
  if (!shouldRender) return '';
  return `
<button
  hx-post="/api/signal/retry-all-now"
  hx-swap="outerHTML"
  class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-orange-500/30 hover:border-orange-500/50 hover:bg-orange-500/10 transition-colors cursor-pointer"
>
  <svg class="h-3 w-3 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
  <span class="text-xs font-medium text-orange-400">Retry All Now</span>
</button>`;
}

/** Render auth status HTML */
function renderAuthStatus(auth: AuthStatusUpdate): string {
  const statusConfig = {
    pending: {
      border: 'border-gray-500/30 bg-gray-500/10',
      icon: `<svg class="h-3 w-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`,
      text: 'text-gray-400',
      label: 'Waiting for auth...',
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
      label: `Authenticated as: ${escapeHtml(auth.username || 'User')}`,
    },
    failed: {
      border: 'border-red-500/30 bg-red-500/10',
      icon: `<svg class="h-3 w-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" /></svg>`,
      text: 'text-red-400',
      label: 'Auth Failed',
    },
  };

  const config = statusConfig[auth.status];
  return `
<div class="flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-900 border border-gray-700 transition-colors duration-300 ${config.border}">
  ${config.icon}
  <span class="text-xs font-medium ${config.text}">${config.label}</span>
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

/** Render pause/resume button */
function renderPauseButton(isPaused: boolean): string {
  if (isPaused) {
    // Show resume button
    return `
<button
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
  } else {
    // Show pause button
    return `
<button
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
      const remotePath = dir.remote_root ? `${dir.remote_root}/${folderName}` : folderName;
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
        <span class="font-mono text-xs text-indigo-300">/${escapeHtml(remotePath)}</span>
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

// Serve dashboard HTML at root
app.get('/', async (c) => {
  const html = await readFile(join(__dirname, 'index.html'), 'utf-8');
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

app.get('/api/fragments/processing', (c) => {
  return c.html(renderProcessingList(getProcessingJobs()));
});

app.get('/api/fragments/processing-count', (c) => {
  return c.html(`${getProcessingJobs().length} items`);
});

app.get('/api/fragments/blocked', (c) => {
  return c.html(renderBlockedList(getBlockedJobs()));
});

app.get('/api/fragments/blocked-count', (c) => {
  return c.html(`${getBlockedJobs().length} items`);
});

app.get('/api/fragments/recent', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderRecentList(getRecentJobs(limit)));
});

app.get('/api/fragments/recent-count', (c) => {
  return c.html(`${getRecentJobs(50).length} items`);
});

app.get('/api/fragments/pending', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderPendingList(getPendingJobs(limit)));
});

app.get('/api/fragments/pending-count', (c) => {
  return c.html(`${getPendingJobs(50).length} items`);
});

app.get('/api/fragments/retry', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  return c.html(renderRetryList(getRetryJobs(limit)));
});

app.get('/api/fragments/retry-count', (c) => {
  return c.html(`${getRetryJobs(50).length} items`);
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
  return c.html(renderPauseButton(currentIsPaused));
});

app.get('/api/fragments/retry-all-button', (c) => {
  return c.html(renderRetryAllButton(getRetryJobs(1).length > 0));
});

/** Toggle pause state */
app.post('/api/toggle-pause', (c) => {
  if (currentIsPaused) {
    clearFlag(FLAGS.PAUSED);
    currentIsPaused = false;
  } else {
    setFlag(FLAGS.PAUSED);
    currentIsPaused = true;
  }
  // Emit status event so all SSE clients get updated
  statusEvents.emit('status', { auth: currentAuthStatus, isPaused: currentIsPaused });
  return c.html(renderPauseButton(currentIsPaused));
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
    return c.html(renderRetryAllButton(getRetryJobs(1).length > 0));
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
  return c.json({ dryRun: isDryRun });
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
    const stateDiffHandler = (_diff: DashboardDiff) => {
      // On any state change, send updated HTML fragments
      const counts = getJobCounts();
      stream.writeSSE({ event: 'stats', data: renderStats(counts) });
      stream.writeSSE({ event: 'processing', data: renderProcessingList(getProcessingJobs()) });
      stream.writeSSE({ event: 'processing-count', data: `${getProcessingJobs().length} items` });
      stream.writeSSE({ event: 'blocked', data: renderBlockedList(getBlockedJobs()) });
      stream.writeSSE({ event: 'blocked-count', data: `${getBlockedJobs().length} items` });
      stream.writeSSE({ event: 'pending', data: renderPendingList(getPendingJobs(50)) });
      stream.writeSSE({ event: 'pending-count', data: `${getPendingJobs(50).length} items` });
      stream.writeSSE({ event: 'recent', data: renderRecentList(getRecentJobs(50)) });
      stream.writeSSE({ event: 'recent-count', data: `${getRecentJobs(50).length} items` });
      stream.writeSSE({ event: 'retry', data: renderRetryList(getRetryJobs(50)) });
      stream.writeSSE({ event: 'retry-count', data: `${getRetryJobs(50).length} items` });
    };

    const statusHandler = (status: DashboardStatus) => {
      // Forward full status: auth, paused badge, pause button, and heartbeat to keep connection alive
      stream.writeSSE({ event: 'auth', data: renderAuthStatus(status.auth) });
      stream.writeSSE({ event: 'paused', data: renderPausedBadge(status.isPaused) });
      stream.writeSSE({ event: 'pause-button', data: renderPauseButton(status.isPaused) });
      // Re-render pending list to update spin animation based on pause state
      stream.writeSSE({ event: 'pending', data: renderPendingList(getPendingJobs(50)) });
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

    await stream.writeSSE({ event: 'stats', data: renderStats(counts) });
    await stream.writeSSE({ event: 'auth', data: renderAuthStatus(currentAuthStatus) });
    await stream.writeSSE({ event: 'paused', data: renderPausedBadge(currentIsPaused) });
    await stream.writeSSE({ event: 'pause-button', data: renderPauseButton(currentIsPaused) });
    await stream.writeSSE({ event: 'processing', data: renderProcessingList(processingJobs) });
    await stream.writeSSE({ event: 'processing-count', data: `${processingJobs.length} items` });
    await stream.writeSSE({ event: 'blocked', data: renderBlockedList(blockedJobs) });
    await stream.writeSSE({ event: 'blocked-count', data: `${blockedJobs.length} items` });
    await stream.writeSSE({ event: 'pending', data: renderPendingList(pendingJobs) });
    await stream.writeSSE({ event: 'pending-count', data: `${pendingJobs.length} items` });
    await stream.writeSSE({ event: 'recent', data: renderRecentList(recentJobs) });
    await stream.writeSSE({ event: 'recent-count', data: `${recentJobs.length} items` });
    await stream.writeSSE({ event: 'retry', data: renderRetryList(retryJobs) });
    await stream.writeSSE({ event: 'retry-count', data: `${retryJobs.length} items` });
    await stream.writeSSE({
      event: 'retry-all-button',
      data: renderRetryAllButton(retryJobs.length > 0),
    });

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

const server = serve({
  fetch: app.fetch,
  port: DASHBOARD_PORT,
});

// Handle server errors (e.g., EADDRINUSE)
server.on('error', (err: NodeJS.ErrnoException) => {
  safeSend({ type: 'error', error: err.message, code: err.code });
  process.exit(1);
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

// Wait for server to be listening before notifying parent
server.on('listening', () => {
  safeSend({ type: 'ready', port: DASHBOARD_PORT });
});

// Exit if parent process dies (IPC channel closes)
process.on('disconnect', () => {
  server.close();
  process.exit(0);
});

// Handle EPIPE errors from IPC when parent exits unexpectedly
process.on('error', () => {
  server.close();
  process.exit(0);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
