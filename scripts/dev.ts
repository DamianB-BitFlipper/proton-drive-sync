#!/usr/bin/env bun
/**
 * Dev Script - File watcher with hot-reload for development
 *
 * Watches src/ for changes to meaningful files and automatically rebuilds
 * and restarts the application.
 *
 * Usage: bun scripts/dev.ts [args...]
 *        make dev ARGS="--debug"
 */

import { watch, type FSWatcher } from 'fs';
import { spawn, type Subprocess } from 'bun';
import { join, extname } from 'path';

// ============================================================================
// Configuration
// ============================================================================

const WATCH_DIR = 'src';
const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.html', '.css', '.json', '.txt', '.sql']);
const DEBOUNCE_MS = 300;
const BUILD_COMMAND = ['make', 'build'];
const APP_COMMAND = ['proton-drive-sync'];

// ============================================================================
// State
// ============================================================================

let appProcess: Subprocess | null = null;
let debounceTimer: Timer | null = null;
let isRebuilding = false;
let watcher: FSWatcher | null = null;

// ============================================================================
// Process Management
// ============================================================================

/**
 * Run the build command (make build)
 */
async function runBuild(): Promise<boolean> {
  console.log('\n\x1b[36m[dev]\x1b[0m Building...');

  const proc = spawn({
    cmd: BUILD_COMMAND,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error('\x1b[31m[dev]\x1b[0m Build failed, waiting for changes...');
    return false;
  }

  console.log('\x1b[32m[dev]\x1b[0m Build complete');
  return true;
}

/**
 * Start the application process
 */
function startApp(args: string[]): void {
  const cmd = [...APP_COMMAND, ...args];
  console.log(`\x1b[36m[dev]\x1b[0m Starting: ${cmd.join(' ')}`);

  // Add dist/ to PATH so proton-drive-sync resolves to the local build
  const env = {
    ...process.env,
    PATH: `${process.cwd()}/dist:${process.env.PATH}`,
  };

  appProcess = spawn({
    cmd,
    stdout: 'inherit',
    stderr: 'inherit',
    env,
  });

  // Handle process exit (crash or normal exit)
  appProcess.exited.then((code) => {
    if (appProcess !== null) {
      console.log(`\x1b[33m[dev]\x1b[0m App exited with code ${code}`);
      appProcess = null;
    }
  });
}

/**
 * Kill the running application process
 */
async function killApp(): Promise<void> {
  if (!appProcess) return;

  const proc = appProcess;
  appProcess = null;

  try {
    proc.kill('SIGTERM');

    // Wait up to 2 seconds for graceful shutdown
    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }, 2000);

    await proc.exited;
    clearTimeout(timeout);
  } catch {
    // Process already dead
  }
}

/**
 * Rebuild and restart the application
 */
async function rebuildAndRestart(args: string[]): Promise<void> {
  if (isRebuilding) return;
  isRebuilding = true;

  try {
    await killApp();

    const buildSuccess = await runBuild();
    if (buildSuccess) {
      startApp(args);
    }
  } finally {
    isRebuilding = false;
  }
}

// ============================================================================
// File Watching
// ============================================================================

/**
 * Check if a file should trigger a rebuild
 */
function shouldWatch(filename: string): boolean {
  // Filter by extension
  const ext = extname(filename).toLowerCase();
  return WATCH_EXTENSIONS.has(ext);
}

/**
 * Handle a file change event (with debouncing)
 */
function handleChange(filename: string, args: string[]): void {
  if (!shouldWatch(filename)) return;

  console.log(`\x1b[90m[dev]\x1b[0m Changed: ${filename}`);

  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set new debounce timer
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    rebuildAndRestart(args);
  }, DEBOUNCE_MS);
}

/**
 * Start watching for file changes
 */
function startWatching(args: string[]): void {
  console.log(`\x1b[36m[dev]\x1b[0m Watching ${WATCH_DIR}/ for changes...`);
  console.log(`\x1b[90m[dev]\x1b[0m Extensions: ${Array.from(WATCH_EXTENSIONS).join(', ')}`);

  watcher = watch(WATCH_DIR, { recursive: true }, (_eventType, filename) => {
    if (filename) {
      handleChange(filename, args);
    }
  });

  watcher.on('error', (err) => {
    console.error(`\x1b[31m[dev]\x1b[0m Watch error: ${err.message}`);
  });
}

// ============================================================================
// Signal Handling
// ============================================================================

/**
 * Clean up and exit
 */
async function cleanup(signal: string): Promise<void> {
  console.log(`\n\x1b[36m[dev]\x1b[0m Received ${signal}, shutting down...`);

  // Stop watching
  if (watcher) {
    watcher.close();
    watcher = null;
  }

  // Clear debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  // Kill app process
  await killApp();

  process.exit(0);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Parse command line args (skip bun and script path)
  const args = process.argv.slice(2);

  console.log('\x1b[36m[dev]\x1b[0m Starting development mode...');
  console.log('\x1b[90m[dev]\x1b[0m Press Ctrl+C to stop\n');

  // Set up signal handlers
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  // Initial build and start
  const buildSuccess = await runBuild();
  if (buildSuccess) {
    startApp(args);
  }

  // Start watching for changes
  startWatching(args);
}

main().catch((err) => {
  console.error(`\x1b[31m[dev]\x1b[0m Fatal error: ${err.message}`);
  process.exit(1);
});