/**
 * Dashboard Subprocess Entry Point
 *
 * This file runs as a separate process, spawned from the main sync process.
 * It communicates with the parent via JSON over stdin/stdout.
 *
 * Uses htmx with SSE - sends HTML fragments for live updates.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createReadStream, statSync, watchFile, unwatchFile } from 'fs';
import { createInterface } from 'readline';
import { join, basename } from 'path';
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
import { FLAGS, ONBOARDING_STATE, setFlag, clearFlag, hasFlag, getFlagData } from '../flags.js';
import { sendSignal } from '../signals.js';
import { logger, enableIpcLogging } from '../logger.js';
import { chownToEffectiveUser } from '../paths.js';
import {
  CONFIG_FILE,
  CONFIG_CHECK_SIGNAL,
  DEFAULT_SYNC_CONCURRENCY,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from '../config.js';
import {
  type AuthStatusUpdate,
  type DashboardDiff,
  type DashboardJob,
  type DashboardStatus,
  type SyncStatus,
  type ParentMessage,
  type ChildMessage,
  sendToParent,
  parseMessage,
} from './ipc.js';
import type { Config } from '../config.js';

import type { JobCounts } from './views/fragments/types.js';

// TSX Fragment Components
import { Stats } from './views/fragments/Stats.js';
import { ProcessingQueue } from './views/fragments/ProcessingQueue.js';
import { BlockedQueue } from './views/fragments/BlockedQueue.js';
import { RecentQueue } from './views/fragments/RecentQueue.js';
import { PendingQueue } from './views/fragments/PendingQueue.js';
import { RetryQueue } from './views/fragments/RetryQueue.js';
import { PauseButton } from './views/fragments/PauseButton.js';
import { ControlsPauseButton } from './views/fragments/ControlsPauseButton.js';
import { AddDirectoryModal } from './views/fragments/AddDirectoryModal.js';
import { NoSyncDirsModal } from './views/fragments/NoSyncDirsModal.js';
import { StartOnLoginSection } from './views/fragments/StartOnLoginSection.js';
import { WelcomeModal } from './views/fragments/WelcomeModal.js';
import { icon } from './views/fragments/Icon.js';

// Embed HTML templates at compile time as text (required for compiled binaries)
import layoutHtml from './layout.html.txt';
import homeHtml from './home.html.txt';
import controlsHtml from './controls.html.txt';
import aboutHtml from './about.html.txt';

// Embed page scripts at compile time
import layoutScriptsHtml from './scripts/layout.scripts.txt';
import homeScriptsHtml from './scripts/home.scripts.txt';
import controlsScriptsHtml from './scripts/controls.scripts.txt';
import aboutScriptsHtml from './scripts/about.scripts.txt';

// Embed assets at compile time (required for compiled binaries)
import iconSvg from './assets/icon.svg' with { type: 'text' };
import githubSvg from './assets/github.svg' with { type: 'text' };
import xLogoSvg from './assets/x-logo.svg' with { type: 'text' };
import stylesCss from './assets/styles.css' with { type: 'text' };
import damianJpgPath from './assets/damian.jpg' with { type: 'file' };

// Asset map for serving embedded assets
const embeddedAssets: Record<string, { content: string; type: string }> = {
  'icon.svg': { content: iconSvg, type: 'image/svg+xml' },
  'github.svg': { content: githubSvg, type: 'image/svg+xml' },
  'x-logo.svg': { content: xLogoSvg, type: 'image/svg+xml' },
  'styles.css': { content: stylesCss, type: 'text/css' },
};

// ============================================================================
// Fragment Registry - Single source of truth for all fragment keys
// ============================================================================

export const FRAG = {
  stats: 'stats',
  processingQueue: 'processing-queue',
  blockedQueue: 'blocked-queue',
  pendingQueue: 'pending-queue',
  recentQueue: 'recent-queue',
  retryQueue: 'retry-queue',
  auth: 'auth',
  paused: 'paused',
  syncing: 'syncing',
  processingTitle: 'processing-title',
  stopSection: 'stop-section',
  controlsPauseButton: 'controls-pause-button',
  pauseButton: 'pause-button',
  dryRunBanner: 'dry-run-banner',
  configInfo: 'config-info',
  welcomeModal: 'welcome-modal',
} as const;

export type FragmentKey = (typeof FRAG)[keyof typeof FRAG];

// ============================================================================
// Dashboard Snapshot - Capture all state once per update
// ============================================================================

export type DashboardSnapshot = {
  counts: ReturnType<typeof getJobCounts>;
  processing: DashboardJob[];
  blocked: DashboardJob[];
  pending: DashboardJob[];
  recent: DashboardJob[];
  retry: DashboardJob[];
  auth: AuthStatusUpdate;
  syncStatus: SyncStatus;
  dryRun: boolean;
  config: Config | null;
};

export function snapshot(): DashboardSnapshot {
  return {
    counts: getJobCounts(),
    processing: getProcessingJobs(),
    blocked: getBlockedJobs(),
    pending: getPendingJobs(),
    recent: getRecentJobs(),
    retry: getRetryJobs(),
    auth: currentAuthStatus,
    syncStatus: currentSyncStatus,
    dryRun: isDryRun,
    config: currentConfig,
  };
}

// ============================================================================
// Constants
// ============================================================================

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

/** Cached job counts - initialized on first SSE connection, updated via diffs */
let cachedCounts: JobCounts | null = null;

/**
 * Read and process messages from parent process via stdin.
 * Messages are newline-delimited JSON.
 */
/**
 * Wait for the initial config message from parent process before starting server.
 * This ensures we have the correct dashboard_host/dashboard_port values.
 */
async function waitForInitialConfig(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    const msg = parseMessage<ParentMessage>(line);
    if (!msg) continue;

    if (msg.type === 'config') {
      if (msg.dryRun !== undefined) isDryRun = msg.dryRun;
      if (msg.config) currentConfig = msg.config;
      rl.close();
      return;
    }
  }
}

async function readParentMessages(): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    const msg = parseMessage<ParentMessage>(line);
    if (!msg) continue;

    if (msg.type === 'job_state_diff') {
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

  // stdin closed - parent exited, shut down
  process.exit(0);
}

// ============================================================================
// HTML Fragment Renderers
// ============================================================================

/** Render stats cards HTML */
function renderStats(counts: {
  pending: number;
  pendingReady: number;
  retry: number;
  processing: number;
  synced: number;
  blocked: number;
}): string {
  return Stats({ counts })!.toString();
}

/** Render processing queue HTML (header with pause button + list) */
function renderProcessingQueue(jobs: DashboardJob[], count: number): string {
  return ProcessingQueue({
    jobs,
    count,
    syncStatus: currentSyncStatus,
    authStatus: currentAuthStatus,
  })!.toString();
}

/** Render blocked queue HTML (header + list) */
function renderBlockedQueue(jobs: DashboardJob[], count: number): string {
  return BlockedQueue({ jobs, count })!.toString();
}

/** Render recent queue HTML (header + list) */
function renderRecentQueue(jobs: DashboardJob[], count: number): string {
  return RecentQueue({ jobs, count })!.toString();
}

/** Render pending queue HTML (header + list) */
function renderPendingQueue(jobs: DashboardJob[], count: number): string {
  return PendingQueue({ jobs, count })!.toString();
}

/** Render retry queue HTML (header with button + list) */
function renderRetryQueue(jobs: DashboardJob[], count: number): string {
  return RetryQueue({ jobs, count })!.toString();
}

/** Render auth status HTML */
function renderAuthStatus(auth: AuthStatusUpdate): string {
  const statusConfig = {
    unauthenticated: {
      border: 'border-gray-500/30 bg-gray-500/10',
      icon: icon('clock', 'h-3 w-3 text-gray-400'),
      text: 'text-gray-400',
      label: 'Not authenticated',
    },
    authenticating: {
      border: 'border-amber-500/30 bg-amber-500/10',
      icon: icon('loader-circle', 'animate-spin h-3 w-3 text-amber-400'),
      text: 'text-amber-400',
      label: 'Authenticating...',
    },
    authenticated: {
      border: 'border-green-500/30 bg-green-500/10',
      icon: icon('check', 'h-3 w-3 text-green-400'),
      text: 'text-green-400',
      label: '', // Set below after status check
    },
    failed: {
      border: 'border-red-500/30 bg-red-500/10',
      icon: icon('x', 'h-3 w-3 text-red-400'),
      text: 'text-red-400',
      label: 'Auth Failed',
    },
  };

  // Set authenticated label only when status is authenticated (to safely access username)
  if (auth.status === 'authenticated') {
    const label = auth.username ? `${auth.username}` : 'Logged in';
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
<div class="bg-gray-800 rounded-xl border border-gray-700 p-6 h-[88px]">
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <h3 class="text-lg font-semibold text-white">Shut Down</h3>
      <div class="relative group flex items-center">
        ${icon('info', 'w-4 h-4 text-gray-500 cursor-help')}
        <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-96 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
          You can start it again with <code class="bg-gray-800 px-1 py-0.5 rounded font-mono">proton-drive-sync start</code>
        </div>
      </div>
    </div>
    <button
      hx-post="/api/signal/stop"
      hx-swap="none"
      hx-disabled-elt="this"
      id="stop-button"
      class="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      ${icon('square', 'w-4 h-4')}
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
  ${icon('circle-pause', 'h-3 w-3 text-amber-400')}
  <span class="text-xs font-medium text-amber-400">Paused</span>
</div>`;
}

/** Render syncing status badge HTML */
function renderSyncingBadge(syncStatus: SyncStatus): string {
  if (syncStatus === 'syncing') {
    return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full border border-green-500/30 bg-green-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
  </div>
  <span class="text-xs font-medium text-green-400">Connected</span>
</div>`;
  }
  if (syncStatus === 'paused') {
    return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full border border-amber-500/30 bg-amber-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500"></span>
  </div>
  <span class="text-xs font-medium text-amber-400">Paused</span>
</div>`;
  }
  // disconnected
  return `
<div class="h-9 flex items-center gap-2 px-3 rounded-full border border-red-500/30 bg-red-500/10">
  <div class="relative flex h-2.5 w-2.5">
    <span id="heartbeat-ping" class="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-0"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
  </div>
  <span class="text-xs font-medium text-red-400">Disconnected</span>
</div>`;
}

/** Render pause/resume button (hidden when disconnected) */
function renderPauseButton(syncStatus: SyncStatus): string {
  return PauseButton({ syncStatus })!.toString();
}

/** Render controls page pause/resume card (hidden when disconnected) */
function renderControlsPauseButton(syncStatus: SyncStatus): string {
  return ControlsPauseButton({ syncStatus })!.toString();
}

/** Render dry-run banner HTML */
function renderDryRunBanner(dryRun: boolean): string {
  if (!dryRun) return '';
  return `
<div class="bg-amber-500/90 text-amber-950 px-4 py-2.5 text-center font-medium text-sm shadow-lg">
  <div class="flex items-center justify-center gap-2">
    ${icon('triangle-alert', 'w-5 h-5')}
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
  ${icon('info', 'w-4 h-4 text-gray-500 cursor-help')}
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

/** Render sync directories HTML for SSR */
function renderSyncDirsHtml(dirs: Config['sync_dirs']): string {
  return dirs
    .map(
      (dir, index) => `
      <div class="flex items-center gap-3 p-4 bg-gray-900 border border-gray-700 rounded-lg group">
        <div class="flex-1 grid grid-cols-2 gap-4">
          <div>
            <label class="block text-xs text-gray-500 mb-1">Local Path</label>
            <input
              type="text"
              value="${escapeHtml(dir.source_path)}"
              onchange="updateSyncDir(${index}, 'source_path', this.value)"
              placeholder="/path/to/local/directory"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
            />
          </div>
          <div>
            <div class="flex items-center gap-1 mb-1">
              <label class="block text-xs text-gray-500">Remote Root</label>
              <div class="relative group">
                ${icon('info', 'w-3 h-3 text-gray-500 cursor-help')}
                <div class="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-xs text-gray-300 w-96 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                  The destination folder in Proton Drive. Must start with / indicating the base of the Proton Drive filesystem.
                </div>
              </div>
            </div>
            <input
              type="text"
              value="${escapeHtml(dir.remote_root || '')}"
              onchange="updateSyncDir(${index}, 'remote_root', this.value)"
              placeholder="/"
              class="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white font-mono text-sm focus:outline-none focus:border-proton"
            />
          </div>
        </div>
        <button
          onclick="removeSyncDir(${index})"
          class="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
          title="Remove directory"
        >
          ${icon('trash-2', 'w-5 h-5')}
        </button>
      </div>
    `
    )
    .join('');
}

/** Render welcome modal */
function renderWelcomeModal(): string {
  return WelcomeModal({})!.toString();
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
        ${icon('folder', 'w-3.5 h-3.5 text-gray-500 shrink-0')}
        <span class="font-mono text-xs text-gray-300">${escapeHtml(dir.source_path)}</span>
      </div>
      
      ${icon('arrow-right', 'w-3 h-3 text-gray-600 shrink-0')}

      <div class="flex items-center gap-2">
        ${icon('cloud', 'w-3.5 h-3.5 text-indigo-400 shrink-0')}
        <span class="font-mono text-xs text-indigo-300">${escapeHtml(remotePath)}</span>
      </div>
    </div>`;
    })
    .join('')}
  </div>`;
}

// ============================================================================
// Unified Fragment Renderer
// ============================================================================

/** Single fragment renderer - renders any fragment by key using snapshot state */
export function renderFragment(key: FragmentKey, s: DashboardSnapshot): string {
  switch (key) {
    case FRAG.stats:
      return renderStats(s.counts);
    case FRAG.processingQueue:
      return renderProcessingQueue(s.processing, s.counts.processing);
    case FRAG.blockedQueue:
      return renderBlockedQueue(s.blocked, s.counts.blocked);
    case FRAG.pendingQueue:
      return renderPendingQueue(s.pending, s.counts.pendingReady);
    case FRAG.recentQueue:
      return renderRecentQueue(s.recent, s.counts.synced);
    case FRAG.retryQueue:
      return renderRetryQueue(s.retry, s.counts.retry);
    case FRAG.auth:
      return renderAuthStatus(s.auth);
    case FRAG.paused:
      return renderPausedBadge(s.syncStatus === 'paused');
    case FRAG.syncing:
      return renderSyncingBadge(s.syncStatus);
    case FRAG.processingTitle:
      return renderProcessingTitle(s.syncStatus === 'paused');
    case FRAG.stopSection:
      return renderStopSection(s.syncStatus);
    case FRAG.controlsPauseButton:
      return renderControlsPauseButton(s.syncStatus);
    case FRAG.pauseButton:
      return renderPauseButton(s.syncStatus);
    case FRAG.dryRunBanner:
      return renderDryRunBanner(s.dryRun);
    case FRAG.configInfo:
      return renderConfigInfo(s.config);
    case FRAG.welcomeModal:
      return renderWelcomeModal();
    default:
      return '';
  }
}

// ============================================================================
// Hono App
// ============================================================================

const app = new Hono();
let isDryRun = false;

/** Get controls scripts with all values injected */
function controlsScriptsWithValues(
  isOnboarding: boolean,
  syncDirs: Array<{ source_path: string; remote_root?: string }>,
  syncConcurrency: number
): string {
  const redirectUrl = isOnboarding ? '/about' : '';
  return controlsScriptsHtml
    .replace('{{REDIRECT_AFTER_SAVE}}', redirectUrl)
    .replace('{{SYNC_DIRS_JSON}}', JSON.stringify(syncDirs))
    .replace('{{SYNC_CONCURRENCY}}', String(syncConcurrency))
    .replace('{{ICON_INFO_SMALL}}', icon('info', 'w-3 h-3 text-gray-500 cursor-help').toString())
    .replace('{{ICON_TRASH}}', icon('trash-2', 'w-5 h-5').toString());
}

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
  }
): Promise<string> {
  const onboardingState = getFlagData(FLAGS.ONBOARDING);
  const hideTabsDuringOnboarding = !onboardingState;
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

  // Get current state for server-side rendering of badges
  const s = snapshot();
  const authStatusContent = renderAuthStatus(s.auth);
  const syncingStatusContent = renderSyncingBadge(s.syncStatus);
  const dryRunBannerContent = renderDryRunBanner(s.dryRun);

  return (
    layoutHtml
      .replace('{{TITLE}}', options.title)
      .replace('{{HOME_TAB_CLASS}}', homeTabClass)
      .replace('{{CONTROLS_TAB_CLASS}}', controlsTabClass)
      .replace('{{ABOUT_TAB_CLASS}}', aboutTabClass)
      .replaceAll('{{HIDE_TABS_DURING_ONBOARDING}}', hideTabsDuringOnboarding ? 'hidden' : '')
      .replace('{{HIDE_BADGES}}', options.activeTab === 'about' ? 'hidden' : '')
      .replace('{{AUTH_STATUS_CONTENT}}', authStatusContent)
      .replace('{{SYNCING_STATUS_CONTENT}}', syncingStatusContent)
      .replace('{{DRY_RUN_BANNER_CONTENT}}', dryRunBannerContent)
      .replace('{{CONTENT}}', contentHtml)
      .replace('{{LAYOUT_SCRIPTS}}', layoutScriptsHtml)
      .replace('{{PAGE_SCRIPTS}}', options.pageScripts)
      // Replace icon placeholders with server-rendered SVGs
      .replace('{{ICON_HOUSE}}', icon('house', 'w-4 h-4 shrink-0').toString())
      .replace('{{ICON_SLIDERS}}', icon('sliders-horizontal', 'w-4 h-4 shrink-0').toString())
      .replace('{{ICON_COMPASS}}', icon('compass', 'w-4 h-4 shrink-0').toString())
      .replaceAll(
        '{{ICON_STAR}}',
        icon('star', 'icon-star w-4 h-4 text-white transition-colors fill-current').toString()
      )
  );
}

// Use embedded layout template
function getLayout(): string {
  return layoutHtml;
}

// Serve dashboard HTML at root
app.get('/', async (c) => {
  // Redirect to controls if not onboarded
  const onboardingState = getFlagData(FLAGS.ONBOARDING);
  if (!onboardingState) {
    return c.redirect('/controls');
  }
  const layout = getLayout();
  const s = snapshot();

  // Server-side render all home page fragments
  const homeContent = homeHtml
    .replace('{{STATS_CONTENT}}', renderFragment(FRAG.stats, s))
    .replace('{{CONFIG_INFO_CONTENT}}', renderFragment(FRAG.configInfo, s))
    .replace('{{PENDING_QUEUE_CONTENT}}', renderFragment(FRAG.pendingQueue, s))
    .replace('{{PROCESSING_QUEUE_CONTENT}}', renderFragment(FRAG.processingQueue, s))
    .replace('{{RECENT_QUEUE_CONTENT}}', renderFragment(FRAG.recentQueue, s))
    .replace('{{RETRY_QUEUE_CONTENT}}', renderFragment(FRAG.retryQueue, s))
    .replace('{{BLOCKED_QUEUE_CONTENT}}', renderFragment(FRAG.blockedQueue, s))
    // Replace icon placeholders
    .replace('{{ICON_ALIGN_LEFT}}', icon('align-left', 'w-4 h-4 text-gray-400').toString())
    .replace(
      '{{ICON_CHEVRON_RIGHT}}',
      icon('chevron-right', 'w-4 h-4 text-gray-500 transition-transform duration-200', undefined)
        .toString()
        .replace('<svg', '<svg id="logs-chevron"')
    );

  const html = await composePage(layout, homeContent, {
    title: 'Proton Drive Sync',
    activeTab: 'home',
    pageScripts: homeScriptsHtml,
  });
  return c.html(html);
});

// Serve controls page
app.get('/controls', async (c) => {
  const layout = getLayout();
  const s = snapshot();
  const isOnboarding = !getFlagData(FLAGS.ONBOARDING);

  // Server-side render stop-section fragment
  let content = controlsHtml
    .replace('{{STOP_SECTION_CONTENT}}', renderFragment(FRAG.stopSection, s))
    .replace('{{CONTROLS_PAUSE_CONTENT}}', renderFragment(FRAG.controlsPauseButton, s));

  // Server-side render start-on-login section
  const serviceEnabled = hasFlag(FLAGS.SERVICE_LOADED);
  content = content.replace(
    '{{START_ON_LOGIN_SECTION}}',
    StartOnLoginSection({ enabled: serviceEnabled })!.toString()
  );

  // Server-side render sync concurrency and directories
  const syncConcurrency = currentConfig?.sync_concurrency ?? DEFAULT_SYNC_CONCURRENCY;
  const syncDirs = currentConfig?.sync_dirs ?? [];
  const syncDirsHtml = syncDirs.length > 0 ? renderSyncDirsHtml(syncDirs) : '';
  const showNoDirsMessage = syncDirs.length === 0;

  content = content
    .replace(/\{\{SYNC_CONCURRENCY\}\}/g, String(syncConcurrency))
    .replace('{{SYNC_DIRS_HTML}}', syncDirsHtml)
    // Replace icon placeholders
    .replace('{{ICON_INFO}}', icon('info', 'w-4 h-4 text-gray-500 cursor-help').toString())
    .replace('{{ICON_PLUS}}', icon('plus', 'w-4 h-4').toString())
    .replace('{{ICON_ARROW_RIGHT}}', icon('arrow-right', 'w-4 h-4').toString());

  // Show/hide "no dirs" message based on whether we have sync dirs
  content = content.replace(
    'id="no-dirs-message" class="hidden',
    `id="no-dirs-message" class="${showNoDirsMessage ? '' : 'hidden'}`
  );

  // Replace button text/icons based on onboarding state
  content = content.replace('{{HIDE_NEXT_BUTTON}}', isOnboarding ? '' : 'hidden');

  // Add welcome modal during onboarding
  if (isOnboarding) {
    content += WelcomeModal({})!.toString();
  }

  const html = await composePage(layout, content, {
    title: 'Controls - Proton Drive Sync',
    activeTab: 'controls',
    pageScripts: controlsScriptsWithValues(isOnboarding, syncDirs, syncConcurrency),
  });
  return c.html(html);
});

// Serve about page
app.get('/about', async (c) => {
  const layout = getLayout();
  let content = aboutHtml;
  // Inject version from package.json (embedded at build time)
  const pkg = await import('../../package.json');
  content = content.replace('{{VERSION}}', pkg.default.version);

  // Get current onboarding state
  const onboardingState = getFlagData(FLAGS.ONBOARDING);

  // Show button only in 'about' state (just arrived from controls)
  const showStartButton = onboardingState === ONBOARDING_STATE.ABOUT;
  content = content.replace('{{HIDE_START_BUTTON}}', showStartButton ? '' : 'hidden');

  // Replace icon placeholders
  content = content
    .replace('{{ICON_HEART}}', icon('heart', 'w-4 h-4 text-gray-500').toString())
    .replace('{{ICON_ROCKET}}', icon('rocket', 'w-4 h-4 ml-1').toString());

  const html = await composePage(layout, content, {
    title: 'About - Proton Drive Sync',
    activeTab: 'about',
    pageScripts: aboutScriptsHtml,
  });
  return c.html(html);
});

// Serve static assets from embedded imports
app.get('/assets/:filename', async (c) => {
  const filename = c.req.param('filename');

  // Check embedded text assets first (SVGs)
  if (filename in embeddedAssets) {
    const asset = embeddedAssets[filename];
    return c.body(asset.content, 200, { 'Content-Type': asset.type });
  }

  // Handle damian.jpg using the embedded file path
  if (filename === 'damian.jpg') {
    const file = Bun.file(damianJpgPath);
    return new Response(file, {
      headers: { 'Content-Type': 'image/jpeg' },
    });
  }

  return c.notFound();
});

// Serve favicon at root for browsers that request /favicon.ico
app.get('/favicon.ico', (c) => {
  return c.body(embeddedAssets['icon.svg'].content, 200, { 'Content-Type': 'image/svg+xml' });
});

// ============================================================================
// HTML Fragment Endpoints
// ============================================================================

// One generic endpoint serves all fragments (e.g., hx-get="/api/fragments/stats")
app.get('/api/fragments/:key', (c) => {
  const key = c.req.param('key') as FragmentKey;
  const s = snapshot();
  return c.html(renderFragment(key, s));
});

// Serve add directory modal
app.get('/api/modal/add-directory', (c) => {
  return c.html(AddDirectoryModal({})!.toString());
});

// Serve no sync dirs warning modal
app.get('/api/modal/no-sync-dirs', (c) => {
  const redirectUrl = c.req.query('redirect') || '';
  return c.html(NoSyncDirsModal({ redirectUrl })!.toString());
});

// Serve welcome modal (shown during onboarding)
app.get('/api/modal/welcome', (c) => {
  return c.html(WelcomeModal({})!.toString());
});

/** Set onboarded flag */
app.post('/api/onboard', (c) => {
  setFlag(FLAGS.ONBOARDING, ONBOARDING_STATE.COMPLETED);
  return c.html('', 200, {
    'HX-Redirect': '/',
  });
});

/** Complete onboarding controls step (sets state to ABOUT) */
app.post('/api/complete-onboarding-controls', (c) => {
  // Check if there are any sync directories configured
  if (!currentConfig?.sync_dirs || currentConfig.sync_dirs.length === 0) {
    // Return the warning modal via HX-Reswap
    // OK button will call /api/complete-onboarding-controls-force to proceed anyway
    return c.html(
      NoSyncDirsModal({ redirectUrl: '/api/complete-onboarding-controls-force' })!.toString(),
      200,
      {
        'HX-Reswap': 'beforeend',
        'HX-Retarget': 'body',
      }
    );
  }

  // Set onboarding state and redirect to about page
  setFlag(FLAGS.ONBOARDING, ONBOARDING_STATE.ABOUT);
  return c.html('', 200, {
    'HX-Redirect': '/about',
  });
});

/** Force complete onboarding controls (skip empty sync dirs warning) */
app.get('/api/complete-onboarding-controls-force', (c) => {
  setFlag(FLAGS.ONBOARDING, ONBOARDING_STATE.ABOUT);
  return c.redirect('/about');
});

/** Toggle service start-on-login */
app.post('/api/toggle-service', (c) => {
  const isEnabled = hasFlag(FLAGS.SERVICE_LOADED);

  if (isEnabled) {
    sendSignal('start-on-login-disable');
  } else {
    sendSignal('start-on-login-enable');
  }

  // Optimistic UI update - return the expected new state
  return c.html(StartOnLoginSection({ enabled: !isEnabled })!.toString());
});

/** Toggle pause state */
app.post('/api/toggle-pause', (c) => {
  const isPaused = currentSyncStatus === 'paused';
  if (isPaused) {
    clearFlag(FLAGS.PAUSED);
  } else {
    setFlag(FLAGS.PAUSED);
  }
  // Signal sync engine to refresh dashboard status immediately
  sendSignal('refresh-dashboard');
  // Return the new button state (optimistic UI update for button only)
  // The badge will update via the heartbeat path when the engine responds
  // Include both pause buttons with OOB swap for the controls page button
  const newStatus = isPaused ? 'syncing' : 'paused';
  const homePauseButton = renderPauseButton(newStatus);
  const controlsPauseButton = renderControlsPauseButton(newStatus);
  return c.html(`${homePauseButton}${controlsPauseButton}`);
});

/** Handle signals from dashboard */
app.post('/api/signal/:signal', (c) => {
  const signal = c.req.param('signal');

  if (signal === 'retry-all-now') {
    retryAllNow();
    // Force a full refresh of UI state (retry-all-now moves jobs between queues)
    const s = snapshot();
    return c.html(renderRetryQueue(s.retry, s.counts.retry));
  }

  if (signal === 'stop') {
    // Set sync status to disconnected before stopping so UI updates
    currentSyncStatus = 'disconnected';
    statusEvents.emit('status', {
      auth: currentAuthStatus,
      syncStatus: 'disconnected',
    });
    sendSignal('stop');
    return c.html('', 200, {
      'HX-Trigger': JSON.stringify({
        showToast: { message: 'Service stopping...', type: 'info', duration: 3000 },
      }),
    });
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
  return c.json(getRecentJobs());
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
      ...currentConfig,
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
    await Bun.write(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    chownToEffectiveUser(CONFIG_FILE);

    // Update local state
    currentConfig = newConfig;

    // Mark as onboarded (shows home tab)
    setFlag(FLAGS.ONBOARDING, ONBOARDING_STATE.ABOUT);

    // Send signal to trigger config reload in sync process
    sendSignal(CONFIG_CHECK_SIGNAL);

    return c.json({ success: true, config: newConfig });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

/** Add a single directory via modal form and return updated list */
app.post('/api/add-directory', async (c) => {
  try {
    const formData = await c.req.parseBody();
    const sourcePath = ((formData.source_path as string) || '').trim();
    const remoteRoot = ((formData.remote_root as string) || '/').trim();

    // Validate source_path is provided
    if (!sourcePath) {
      return c.html('', 400, {
        'HX-Reswap': 'none',
        'HX-Trigger': JSON.stringify({
          showToast: { message: 'Local path is required', type: 'error' },
        }),
      });
    }

    // Validate remote_root starts with /
    if (remoteRoot && !remoteRoot.startsWith('/')) {
      return c.html('', 400, {
        'HX-Reswap': 'none',
        'HX-Trigger': JSON.stringify({
          showToast: { message: 'Remote root must start with /', type: 'error' },
        }),
      });
    }

    // Validate local path exists on filesystem (works for both files and directories)
    let pathExists = false;
    try {
      statSync(sourcePath);
      pathExists = true;
    } catch {
      pathExists = false;
    }
    if (!pathExists) {
      return c.html('', 400, {
        'HX-Reswap': 'none',
        'HX-Trigger': JSON.stringify({
          showToast: { message: `Local path does not exist: ${sourcePath}`, type: 'error' },
        }),
      });
    }

    // Add to config
    const newDir = { source_path: sourcePath, remote_root: remoteRoot };
    const newConfig: Config = {
      ...currentConfig,
      sync_dirs: [...(currentConfig?.sync_dirs || []), newDir],
      sync_concurrency: currentConfig?.sync_concurrency || 8,
    };

    // Write to config file
    await Bun.write(CONFIG_FILE, JSON.stringify(newConfig, null, 2));
    chownToEffectiveUser(CONFIG_FILE);
    currentConfig = newConfig;

    // Signal config reload
    sendSignal(CONFIG_CHECK_SIGNAL);

    // Return updated list HTML + trigger events to close modal, sync JS state, and show toast
    const html = renderSyncDirsHtml(newConfig.sync_dirs);
    return c.html(html, 200, {
      'HX-Trigger': JSON.stringify({
        'dir-added': { dirs: newConfig.sync_dirs },
        'close-modal': true,
        showToast: { message: 'Config updated', type: 'success' },
      }),
    });
  } catch (err) {
    return c.html('', 500, {
      'HX-Reswap': 'none',
      'HX-Trigger': JSON.stringify({
        showToast: { message: `Error: ${(err as Error).message}`, type: 'error' },
      }),
    });
  }
});

app.get('/api/auth', (c) => {
  return c.json(currentAuthStatus);
});

// ============================================================================
// SSE Endpoints - Send HTML Fragments
// ============================================================================

/** Push multiple fragments to an SSE stream in one go */
function pushFragments(
  stream: { writeSSE: (msg: { event: string; data: string }) => void },
  s: DashboardSnapshot,
  keys: FragmentKey[]
) {
  for (const key of keys) {
    stream.writeSSE({ event: key, data: renderFragment(key, s) });
  }
}

/** Get a comparable string of processing job IDs for change detection */
function processingIds(jobs: DashboardJob[]): string {
  return jobs
    .map((j) => j.id)
    .sort((a, b) => a - b)
    .join(',');
}

// GET /api/events - SSE stream of HTML fragment updates
app.get('/api/events', async (c) => {
  return streamSSE(c, async (stream) => {
    // Track processing jobs to avoid unnecessary re-renders
    let lastProcessing = '';

    // Initial full push - get full state from DB
    const initialSnapshot = snapshot();
    cachedCounts = { ...initialSnapshot.counts }; // Cache initial counts from DB
    lastProcessing = processingIds(initialSnapshot.processing);

    // In-memory job lists - initialized from snapshot, updated via diffs
    let cachedProcessing = [...initialSnapshot.processing];
    let cachedBlocked = [...initialSnapshot.blocked];
    let cachedPending = [...initialSnapshot.pending];
    let cachedRecent = [...initialSnapshot.recent];
    let cachedRetry = [...initialSnapshot.retry];

    pushFragments(stream, initialSnapshot, [
      FRAG.stats,
      FRAG.auth,
      FRAG.paused,
      FRAG.syncing,
      FRAG.processingTitle,
      FRAG.pauseButton,
      FRAG.controlsPauseButton,
      FRAG.processingQueue,
      FRAG.blockedQueue,
      FRAG.pendingQueue,
      FRAG.recentQueue,
      FRAG.retryQueue,
      FRAG.stopSection,
      FRAG.dryRunBanner,
      FRAG.configInfo,
      FRAG.welcomeModal,
    ]);

    // Helper to apply list diffs (add items, remove by id)
    const applyListDiff = (
      list: DashboardJob[],
      add: DashboardJob[],
      removeIds: number[]
    ): DashboardJob[] => {
      // Remove items by id
      const removeSet = new Set(removeIds);
      const filtered = list.filter((job) => !removeSet.has(job.id));
      // Add new items
      return [...filtered, ...add];
    };

    // Debounce pushing fragments to the SSE stream
    const FRAGMENT_DEBOUNCE_MS = 100;
    let fragmentDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    const flushFragments = () => {
      fragmentDebounceTimer = null;

      // Build snapshot with cached counts and lists (no DB queries)
      const s: DashboardSnapshot = {
        counts: cachedCounts || getJobCounts(),
        processing: cachedProcessing,
        blocked: cachedBlocked,
        pending: cachedPending,
        recent: cachedRecent,
        retry: cachedRetry,
        auth: currentAuthStatus,
        syncStatus: currentSyncStatus,
        dryRun: isDryRun,
        config: currentConfig,
      };
      const curProcessing = processingIds(s.processing);

      // Always push stats & non-heavy lists
      pushFragments(stream, s, [
        FRAG.stats,
        FRAG.blockedQueue,
        FRAG.pendingQueue,
        FRAG.recentQueue,
        FRAG.retryQueue,
      ]);

      // Only push processing queue if changed
      if (curProcessing !== lastProcessing) {
        lastProcessing = curProcessing;
        pushFragments(stream, s, [FRAG.processingQueue]);
      }
    };

    // Job diff: apply deltas to cached counts and lists, debounce fragment push
    const onJobDiff = (diff: DashboardDiff) => {
      // Apply deltas to cached counts (avoid DB query for counts)
      if (cachedCounts) {
        cachedCounts.pending += diff.statsDelta.pending;
        cachedCounts.processing += diff.statsDelta.processing;
        cachedCounts.synced += diff.statsDelta.synced;
        cachedCounts.blocked += diff.statsDelta.blocked;
        cachedCounts.retry += diff.statsDelta.retry;
        // Derive pendingReady from pending - retry
        cachedCounts.pendingReady = cachedCounts.pending - cachedCounts.retry;

        // Ensure non-negative values
        cachedCounts.pending = Math.max(0, cachedCounts.pending);
        cachedCounts.pendingReady = Math.max(0, cachedCounts.pendingReady);
        cachedCounts.processing = Math.max(0, cachedCounts.processing);
        cachedCounts.synced = Math.max(0, cachedCounts.synced);
        cachedCounts.blocked = Math.max(0, cachedCounts.blocked);
        cachedCounts.retry = Math.max(0, cachedCounts.retry);
      }

      // Apply diffs to in-memory job lists
      cachedProcessing = applyListDiff(cachedProcessing, diff.addProcessing, diff.removeProcessing);
      cachedBlocked = [...cachedBlocked, ...diff.addBlocked]; // append-only
      cachedPending = applyListDiff(cachedPending, diff.addPending, diff.removePending);
      cachedRecent = [...diff.addRecent, ...cachedRecent]; // prepend new items (newest first)
      cachedRetry = applyListDiff(cachedRetry, diff.addRetry, diff.removeRetry);

      // Debounce the fragment push
      if (!fragmentDebounceTimer) {
        fragmentDebounceTimer = setTimeout(flushFragments, FRAGMENT_DEBOUNCE_MS);
      }
    };

    // Status change: push status-related fragments
    const onStatus = (status: DashboardStatus) => {
      const s: DashboardSnapshot = {
        ...snapshot(),
        auth: status.auth,
        syncStatus: status.syncStatus,
      };
      pushFragments(stream, s, [
        FRAG.auth,
        FRAG.paused,
        FRAG.syncing,
        FRAG.processingTitle,
        FRAG.pauseButton,
        FRAG.controlsPauseButton,
        FRAG.stopSection,
        FRAG.processingQueue, // Re-render to update spinners when paused/resumed
        FRAG.welcomeModal,
      ]);
      stream.writeSSE({ event: 'heartbeat', data: '' });
    };

    const onHeartbeat = () => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    };

    stateDiffEvents.on('job_state_diff', onJobDiff);
    statusEvents.on('status', onStatus);
    heartbeatEvents.on('heartbeat', onHeartbeat);

    stream.onAbort(() => {
      if (fragmentDebounceTimer) clearTimeout(fragmentDebounceTimer);
      stateDiffEvents.off('job_state_diff', onJobDiff);
      statusEvents.off('status', onStatus);
      heartbeatEvents.off('heartbeat', onHeartbeat);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// Maximum number of log lines to send on initial connection
const MAX_INITIAL_LOG_LINES = 500;

// GET /api/logs - SSE stream of log lines as HTML
app.get('/api/logs', async (c) => {
  return streamSSE(c, async (stream) => {
    // Start from where the log file was when dashboard subprocess started
    let currentPosition = initialLogPosition;
    let isInitialLoad = true;

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

        // Collect lines first if initial load (to limit count and batch into single SSE event)
        if (isInitialLoad) {
          const lines: string[] = [];
          for await (const line of rl) {
            if (line.trim()) {
              lines.push(line);
            }
          }
          // Only send the last MAX_INITIAL_LOG_LINES, batched into a single SSE event
          const startIndex = Math.max(0, lines.length - MAX_INITIAL_LOG_LINES);
          const batchedHtml = lines
            .slice(startIndex)
            .map((line) => renderLogLine(line))
            .join('');
          if (batchedHtml) {
            await stream.writeSSE({
              event: 'log',
              data: batchedHtml,
            });
          }
          isInitialLoad = false;
        } else {
          // Stream new lines directly (one at a time is fine for incremental updates)
          for await (const line of rl) {
            if (line.trim()) {
              await stream.writeSSE({
                event: 'log',
                data: renderLogLine(line),
              });
            }
          }
        }

        currentPosition = stats.size;
      } catch {
        // Ignore errors (file might not exist yet)
      }
    };

    // Send logs from startup (limited to last MAX_INITIAL_LOG_LINES)
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

/**
 * Start the dashboard server. Called via 'start --dashboard' command.
 * Communicates with parent process via stdin (receive) and stdout (send).
 */
async function runDashboardServer(): Promise<void> {
  // The dashboard subprocess communicates with the sync client via stdin/stdout:
  // - stdin: receives JSON messages from parent (config, status updates, heartbeats)
  // - stdout: sends JSON messages to parent (ready signal, errors, log messages)
  // Console logging is replaced with IPC logging so logs appear in the main process.
  enableIpcLogging();

  /**
   * Safely send IPC message to parent process via stdout.
   */
  function safeSend(message: ChildMessage): void {
    try {
      sendToParent(message);
    } catch {
      // stdout closed, parent exited - shut down gracefully
      process.exit(0);
    }
  }

  try {
    // Wait for initial config from parent before starting server
    // This ensures we have the correct dashboard_host/dashboard_port values
    await waitForInitialConfig();

    const host = currentConfig?.dashboard_host ?? DEFAULT_DASHBOARD_HOST;
    const port = currentConfig?.dashboard_port ?? DEFAULT_DASHBOARD_PORT;

    // Security warning for external interface binding
    if (host === '0.0.0.0' || (host !== '127.0.0.1' && host !== 'localhost')) {
      logger.warn('Dashboard bound to external interface');
      logger.warn('The dashboard allows service control and config changes');
      logger.warn('Ensure your network is secure or use a firewall');
    }

    const server = Bun.serve({
      fetch: app.fetch,
      port,
      hostname: host,
      idleTimeout: 0, // Disable timeout - SSE connections stay open indefinitely
    });

    // Bun.serve() is synchronous - if we reach here, server is listening
    safeSend({ type: 'ready', port, host });

    // Start reading messages from parent via stdin
    readParentMessages();

    // Graceful shutdown helper - exit immediately
    // SSE connections keep the server alive, so we can't wait for server.stop()
    function shutdown() {
      server.stop();
      process.exit(0);
    }

    // Graceful shutdown
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (err) {
    const error = err as Error & { code?: string };
    safeSend({ type: 'error', error: error.message, code: error.code });
    process.exit(1);
  }
}

/** Entry point - called when running as dashboard subprocess via 'start --dashboard' */
export function startDashboardMode(): void {
  runDashboardServer().catch((err) => {
    logger.error(`Dashboard server failed: ${err}`);
    process.exit(1);
  });
}
