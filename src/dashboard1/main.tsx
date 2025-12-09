/**
 * Dashboard1 Subprocess Entry Point
 *
 * This file runs as a separate Node.js process, forked from the main sync process.
 * It communicates with the parent via IPC for job events (received as diffs).
 *
 * This version sends JSON events via SSE (like the original dashboard) and uses
 * vanilla client-side JavaScript to apply diffs incrementally.
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { createReadStream, statSync, watchFile, unwatchFile } from 'fs';
import { readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { xdgState } from 'xdg-basedir';
import { EventEmitter } from 'events';
import { getJobCounts, getRecentJobs, getBlockedJobs, getProcessingJobs } from '../sync/queue.js';
import type { DashboardDiff, AuthStatusUpdate } from './server.js';

// ============================================================================
// Constants
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DASHBOARD_PORT = 4243;
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
const authEvents = new EventEmitter();

// Current auth status (for API endpoint)
let currentAuthStatus: AuthStatusUpdate = { status: 'pending' };

// Listen for diff events from parent process via IPC
process.on(
  'message',
  (msg: { type: string; diff?: DashboardDiff; dryRun?: boolean } & Partial<AuthStatusUpdate>) => {
    if (msg.type === 'job_state_diff' && msg.diff) {
      stateDiffEvents.emit('job_state_diff', msg.diff);
    } else if (msg.type === 'config' && msg.dryRun !== undefined) {
      isDryRun = msg.dryRun;
    } else if (msg.type === 'auth') {
      currentAuthStatus = {
        status: msg.status!,
        username: msg.username,
      };
      authEvents.emit('auth', currentAuthStatus);
    }
  }
);

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

// ============================================================================
// JSON API Endpoints
// ============================================================================

// GET /api/stats - Job queue counts
app.get('/api/stats', (c) => {
  const counts = getJobCounts();
  return c.json(counts);
});

// GET /api/jobs/recent - Recently synced jobs
app.get('/api/jobs/recent', (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const jobs = getRecentJobs(limit);
  return c.json(jobs);
});

// GET /api/jobs/blocked - Blocked jobs
app.get('/api/jobs/blocked', (c) => {
  const jobs = getBlockedJobs();
  return c.json(jobs);
});

// GET /api/jobs/processing - Currently processing jobs
app.get('/api/jobs/processing', (c) => {
  const jobs = getProcessingJobs();
  return c.json(jobs);
});

// GET /api/config - Dashboard configuration
app.get('/api/config', (c) => {
  return c.json({ dryRun: isDryRun });
});

// GET /api/auth - Current auth status
app.get('/api/auth', (c) => {
  return c.json(currentAuthStatus);
});

// ============================================================================
// SSE Endpoints
// ============================================================================

// GET /api/events - SSE stream of job state changes (diffs) and auth status
app.get('/api/events', async (c) => {
  return streamSSE(c, async (stream) => {
    const stateDiffHandler = (diff: DashboardDiff) => {
      stream.writeSSE({
        event: 'job_state_diff',
        data: JSON.stringify(diff),
      });
    };

    const authHandler = (auth: AuthStatusUpdate) => {
      stream.writeSSE({
        event: 'auth',
        data: JSON.stringify(auth),
      });
    };

    stateDiffEvents.on('job_state_diff', stateDiffHandler);
    authEvents.on('auth', authHandler);

    // Send initial stats
    await stream.writeSSE({
      event: 'stats',
      data: JSON.stringify(getJobCounts()),
    });

    // Send current auth status
    await stream.writeSSE({
      event: 'auth',
      data: JSON.stringify(currentAuthStatus),
    });

    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' });
    }, 30000);

    // Cleanup on close
    stream.onAbort(() => {
      clearInterval(heartbeat);
      stateDiffEvents.off('job_state_diff', stateDiffHandler);
      authEvents.off('auth', authHandler);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// GET /api/logs - SSE stream of log lines since dashboard startup
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
              data: line,
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
  if (process.send) {
    process.send({ type: 'error', error: err.message, code: err.code });
  }
  process.exit(1);
});

// Wait for server to be listening before notifying parent
server.on('listening', () => {
  if (process.send) {
    process.send({ type: 'ready', port: DASHBOARD_PORT });
  }
});

// Exit if parent process dies (IPC channel closes)
process.on('disconnect', () => {
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
