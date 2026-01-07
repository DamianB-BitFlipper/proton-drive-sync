/**
 * File Watcher (fs.watch)
 *
 * Handles file change detection using Node's built-in fs.watch with
 * fileHashes DB table for persistence and change detection.
 */

import { watch, type FSWatcher, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { eq, like } from 'drizzle-orm';
import { logger } from '../logger.js';
import { type Config } from '../config.js';
import { db } from '../db/index.js';
import { fileHashes } from '../db/schema.js';
import {
  WATCHER_DEBOUNCE_MS,
  RECONCILIATION_INTERVAL_MS,
  DIRTY_PATH_DEBOUNCE_MS,
} from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newly created
  watchRoot: string; // Which watch root this change came from
  ino: number; // Inode number (0 if unavailable)
}

export type FileChangeHandler = (file: FileChange) => void;
export type FileChangeBatchHandler = (files: FileChange[]) => void;

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// State
// ============================================================================

/** Track active fs.watch watchers for teardown */
const activeWatchers: Map<string, FSWatcher> = new Map();

/** Track paths with recent events for incremental reconciliation (path -> timestamp when first marked dirty) */
const dirtyPaths: Map<string, number> = new Map();

/** Debounce timers per path */
const debounceTimers: Map<string, Timer> = new Map();

/** Reconciliation timer */
let reconciliationTimer: Timer | null = null;

/** Stored references for reconciliation callback */
let reconciliationConfig: Config | null = null;
let reconciliationCallback: FileChangeBatchHandler | null = null;

// ============================================================================
// Hash Helpers
// ============================================================================

/**
 * Build a content hash from mtime and size (format: "mtime_ms:size")
 */
function buildHash(mtime_ms: number, size: number): string {
  return `${mtime_ms}:${size}`;
}

/**
 * Get stored hash for a path from the database
 */
function getStoredHash(localPath: string): string | null {
  const result = db.select().from(fileHashes).where(eq(fileHashes.localPath, localPath)).get();
  return result?.contentHash ?? null;
}

/**
 * Get all stored hashes under a sync directory
 */
function getAllStoredHashes(syncDirPath: string): Map<string, string> {
  const pathPrefix = syncDirPath.endsWith('/') ? syncDirPath : `${syncDirPath}/`;
  const results = db
    .select()
    .from(fileHashes)
    .where(like(fileHashes.localPath, `${pathPrefix}%`))
    .all();

  const hashMap = new Map<string, string>();
  for (const row of results) {
    hashMap.set(row.localPath, row.contentHash);
  }
  return hashMap;
}

// ============================================================================
// File System Scanning
// ============================================================================

/**
 * Scan a directory recursively and return all files/directories with their stats
 */
export async function scanDirectory(
  watchDir: string
): Promise<Map<string, { size: number; mtime_ms: number; isDirectory: boolean; ino: number }>> {
  const results = new Map<
    string,
    { size: number; mtime_ms: number; isDirectory: boolean; ino: number }
  >();

  try {
    // Use Bun.Glob to scan all files and directories
    const glob = new Bun.Glob('**/*');
    const entries = glob.scanSync({ cwd: watchDir, dot: false });

    for (const entry of entries) {
      const fullPath = join(watchDir, entry);
      try {
        const stats = statSync(fullPath);
        results.set(fullPath, {
          size: stats.size,
          mtime_ms: stats.mtimeMs,
          isDirectory: stats.isDirectory(),
          ino: stats.ino,
        });
      } catch {
        // File may have been deleted during scan, skip it
      }
    }
  } catch (err) {
    logger.warn(
      `Failed to scan directory ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return results;
}

/**
 * Compare filesystem state against stored hashes and generate changes
 */
function compareWithStoredHashes(
  watchDir: string,
  fsState: Map<string, { size: number; mtime_ms: number; isDirectory: boolean; ino: number }>,
  storedHashes: Map<string, string>
): FileChange[] {
  const changes: FileChange[] = [];

  // Check for new and updated files
  for (const [fullPath, stats] of fsState) {
    const relativePath = relative(watchDir, fullPath);
    const currentHash = buildHash(stats.mtime_ms, stats.size);
    const storedHash = storedHashes.get(fullPath);

    if (!storedHash) {
      // New file/directory
      changes.push({
        name: relativePath,
        size: stats.size,
        mtime_ms: stats.mtime_ms,
        exists: true,
        type: stats.isDirectory ? 'd' : 'f',
        new: true,
        watchRoot: watchDir,
        ino: stats.ino,
      });
    } else if (storedHash !== currentHash && !stats.isDirectory) {
      // File updated (only track changes for files, not directories)
      changes.push({
        name: relativePath,
        size: stats.size,
        mtime_ms: stats.mtime_ms,
        exists: true,
        type: 'f',
        new: false,
        watchRoot: watchDir,
        ino: stats.ino,
      });
    }
  }

  // Check for deleted files (in DB but not on filesystem)
  for (const [storedPath] of storedHashes) {
    if (!fsState.has(storedPath)) {
      const relativePath = relative(watchDir, storedPath);
      changes.push({
        name: relativePath,
        size: 0,
        mtime_ms: Date.now(),
        exists: false,
        type: 'f', // We don't know if it was a file or directory
        new: false,
        watchRoot: watchDir,
        ino: 0,
      });
    }
  }

  return changes;
}

// ============================================================================
// Watcher Initialization
// ============================================================================

/**
 * Initialize the watcher (no-op for fs.watch - no daemon needed)
 */
export async function initializeWatcher(): Promise<void> {
  logger.debug('File watcher initialized');
}

/**
 * Close the watcher and clean up subscriptions
 */
export async function closeWatcher(): Promise<void> {
  await teardownWatchSubscriptions();
}

/**
 * Clear all stored file hashes (used by reset command to force full resync)
 * Returns the number of hashes cleared
 */
export function clearAllSnapshots(): number {
  const result = db.select().from(fileHashes).all();
  const count = result.length;
  db.delete(fileHashes).run();
  return count;
}

// ============================================================================
// One-shot Query (Startup Scan)
// ============================================================================

/**
 * Query all configured directories for changes since last sync.
 * Compares filesystem state against fileHashes table.
 */
export async function queryAllChanges(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<number> {
  let totalChanges = 0;

  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist: ${watchDir}`);
      continue;
    }

    // Get stored hashes for this sync directory
    const storedHashes = getAllStoredHashes(watchDir);
    const hasStoredState = storedHashes.size > 0;

    if (hasStoredState) {
      logger.info(`Syncing changes since last run for ${dir.source_path}...`);
    } else {
      logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
    }

    // Scan the filesystem
    const fsState = await scanDirectory(watchDir);

    // Compare and generate changes
    const changes = compareWithStoredHashes(watchDir, fsState, storedHashes);

    if (changes.length > 0) {
      onFileChangeBatch(changes);
      totalChanges += changes.length;
    }
  }

  return totalChanges;
}

// ============================================================================
// Live Watching (fs.watch)
// ============================================================================

/**
 * Handle a debounced file system event
 */
function handleDebouncedEvent(
  watchDir: string,
  filename: string,
  onFileChangeBatch: FileChangeBatchHandler
): void {
  const fullPath = join(watchDir, filename);
  const relativePath = filename;

  // Add to dirty paths for incremental reconciliation (only if not already tracked)
  if (!dirtyPaths.has(fullPath)) {
    dirtyPaths.set(fullPath, Date.now());
  }

  try {
    if (existsSync(fullPath)) {
      // File exists - it's either a create or update
      const stats = statSync(fullPath);
      const currentHash = buildHash(stats.mtimeMs, stats.size);
      const storedHash = getStoredHash(fullPath);

      const isNew = !storedHash;
      const isChanged = storedHash && storedHash !== currentHash;

      // Skip if file hasn't actually changed
      if (!isNew && !isChanged) {
        logger.debug(`[watcher] no change detected: ${filename}`);
        return;
      }

      const change: FileChange = {
        name: relativePath,
        size: stats.size,
        mtime_ms: stats.mtimeMs,
        exists: true,
        type: stats.isDirectory() ? 'd' : 'f',
        new: isNew,
        watchRoot: watchDir,
        ino: stats.ino,
      };

      onFileChangeBatch([change]);
    } else {
      // File doesn't exist - it's a delete
      const change: FileChange = {
        name: relativePath,
        size: 0,
        mtime_ms: Date.now(),
        exists: false,
        type: 'f', // Default to file
        new: false,
        watchRoot: watchDir,
        ino: 0,
      };

      onFileChangeBatch([change]);
    }
  } catch (err) {
    logger.debug(
      `[watcher] Error handling event for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Set up watch subscriptions for all configured directories.
 * Calls onFileChangeBatch for each batch of file changes detected.
 */
export async function setupWatchSubscriptions(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<void> {
  // Clear any existing subscriptions first
  await teardownWatchSubscriptions();

  // Store references for reconciliation
  reconciliationConfig = config;
  reconciliationCallback = onFileChangeBatch;

  // Set up watches for all configured directories
  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist, skipping watch: ${watchDir}`);
      continue;
    }

    try {
      const fsWatcher = watch(watchDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;

        // Clear existing debounce timer for this path
        const timerKey = `${watchDir}:${filename}`;
        const existingTimer = debounceTimers.get(timerKey);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set new debounce timer
        const timer = setTimeout(() => {
          debounceTimers.delete(timerKey);
          handleDebouncedEvent(watchDir, filename, onFileChangeBatch);
        }, WATCHER_DEBOUNCE_MS);

        debounceTimers.set(timerKey, timer);
      });

      fsWatcher.on('error', (err) => {
        logger.error(`Watcher error for ${watchDir}: ${err.message}`);
      });

      activeWatchers.set(watchDir, fsWatcher);
      logger.info(`Watching ${dir.source_path} for changes...`);
    } catch (err) {
      logger.error(
        `Failed to watch ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Start incremental reconciliation timer
  startReconciliationTimer();

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Tear down all active watch subscriptions.
 * Call this before re-setting up subscriptions on config change.
 */
export async function teardownWatchSubscriptions(): Promise<void> {
  // Stop reconciliation timer
  stopReconciliationTimer();

  // Clear debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  // Close all watchers
  if (activeWatchers.size === 0) return;

  logger.info('Tearing down watch subscriptions...');

  for (const [watchDir, fsWatcher] of activeWatchers) {
    try {
      fsWatcher.close();
      logger.debug(`Closed watcher for ${watchDir}`);
    } catch (err) {
      logger.warn(`Failed to close watcher for ${watchDir}: ${(err as Error).message}`);
    }
  }

  activeWatchers.clear();
  dirtyPaths.clear();

  // Clear reconciliation references
  reconciliationConfig = null;
  reconciliationCallback = null;
}

// ============================================================================
// Incremental Reconciliation
// ============================================================================

/**
 * Start the incremental reconciliation timer
 */
function startReconciliationTimer(): void {
  if (reconciliationTimer) return;

  reconciliationTimer = setInterval(() => {
    runIncrementalReconciliation();
  }, RECONCILIATION_INTERVAL_MS);
}

/**
 * Stop the reconciliation timer
 */
function stopReconciliationTimer(): void {
  if (reconciliationTimer) {
    clearInterval(reconciliationTimer);
    reconciliationTimer = null;
  }
}

/**
 * Run incremental reconciliation on dirty paths only
 */
function runIncrementalReconciliation(): void {
  if (dirtyPaths.size === 0) {
    logger.debug('[reconcile] No dirty paths to reconcile');
    return;
  }

  if (!reconciliationCallback || !reconciliationConfig) {
    logger.debug('[reconcile] No reconciliation callback configured');
    return;
  }

  // Filter to paths that have been dirty for at least DIRTY_PATH_DEBOUNCE_MS
  const now = Date.now();
  const eligiblePaths: string[] = [];
  for (const [fullPath, timestamp] of dirtyPaths) {
    if (now - timestamp >= DIRTY_PATH_DEBOUNCE_MS) {
      eligiblePaths.push(fullPath);
    }
  }

  if (eligiblePaths.length === 0) {
    logger.debug(
      `[reconcile] ${dirtyPaths.size} dirty paths not yet eligible (debouncing for ${DIRTY_PATH_DEBOUNCE_MS / 1000}s)`
    );
    return;
  }

  logger.debug(`[reconcile] Running incremental reconciliation on ${eligiblePaths.length} paths`);

  const changes: FileChange[] = [];

  // Group dirty paths by watch root
  const pathsByRoot = new Map<string, string[]>();
  for (const fullPath of eligiblePaths) {
    const watchDir = reconciliationConfig.sync_dirs.find((d) =>
      fullPath.startsWith(d.source_path)
    )?.source_path;

    if (watchDir) {
      const paths = pathsByRoot.get(watchDir) || [];
      paths.push(fullPath);
      pathsByRoot.set(watchDir, paths);
    }
  }

  // Check each dirty path
  for (const [watchDir, paths] of pathsByRoot) {
    for (const fullPath of paths) {
      const relativePath = relative(watchDir, fullPath);
      const storedHash = getStoredHash(fullPath);

      try {
        if (existsSync(fullPath)) {
          const stats = statSync(fullPath);
          const currentHash = buildHash(stats.mtimeMs, stats.size);

          // Check if there's a discrepancy
          if (!storedHash) {
            // File exists but no hash stored - should have been created
            changes.push({
              name: relativePath,
              size: stats.size,
              mtime_ms: stats.mtimeMs,
              exists: true,
              type: stats.isDirectory() ? 'd' : 'f',
              new: true,
              watchRoot: watchDir,
              ino: stats.ino,
            });
          } else if (storedHash !== currentHash && !stats.isDirectory()) {
            // Hash mismatch - should have been updated
            changes.push({
              name: relativePath,
              size: stats.size,
              mtime_ms: stats.mtimeMs,
              exists: true,
              type: 'f',
              new: false,
              watchRoot: watchDir,
              ino: stats.ino,
            });
          }
        } else if (storedHash) {
          // File doesn't exist but hash is stored - should have been deleted
          changes.push({
            name: relativePath,
            size: 0,
            mtime_ms: Date.now(),
            exists: false,
            type: 'f',
            new: false,
            watchRoot: watchDir,
            ino: 0,
          });
        }
      } catch (err) {
        logger.debug(
          `[reconcile] Error checking ${fullPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Clear only the paths that were checked (eligible paths)
  for (const fullPath of eligiblePaths) {
    dirtyPaths.delete(fullPath);
  }

  // Emit any missed changes
  if (changes.length > 0) {
    logger.info(`[reconcile] Found ${changes.length} missed changes`);
    reconciliationCallback(changes);
  }
}

// ============================================================================
// Full Reconciliation (for reconcile command)
// ============================================================================

/**
 * Trigger a full filesystem reconciliation.
 * Called by the reconcile CLI command via signal.
 */
export async function triggerFullReconciliation(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler
): Promise<number> {
  logger.info('Running full filesystem reconciliation...');

  let totalChanges = 0;

  for (const dir of config.sync_dirs) {
    const watchDir = dir.source_path;

    if (!existsSync(watchDir)) {
      logger.warn(`Sync directory does not exist: ${watchDir}`);
      continue;
    }

    // Get stored hashes for this sync directory
    const storedHashes = getAllStoredHashes(watchDir);

    // Scan the filesystem
    const fsState = await scanDirectory(watchDir);

    // Compare and generate changes
    const changes = compareWithStoredHashes(watchDir, fsState, storedHashes);

    if (changes.length > 0) {
      onFileChangeBatch(changes);
      totalChanges += changes.length;
    }
  }

  logger.info(`Full reconciliation complete: ${totalChanges} changes found`);
  return totalChanges;
}
