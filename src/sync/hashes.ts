/**
 * Proton Drive Sync - File Hash Storage
 *
 * Tracks content hashes for synced files to detect actual content changes.
 * Used to skip uploads when file content hasn't changed.
 */

import { eq, like } from 'drizzle-orm';
import { type Tx } from '../db/index.js';
import { fileHashes } from '../db/schema.js';
import { getConfig } from '../config.js';

// ============================================================================
// Hash Storage CRUD
// ============================================================================

/**
 * Get the stored content hash for a local path.
 */
export function getStoredHash(localPath: string, tx: Tx): string | null {
  const result = tx.select().from(fileHashes).where(eq(fileHashes.localPath, localPath)).get();
  return result?.contentHash ?? null;
}

/**
 * Delete the stored hash for a local path.
 */
export function deleteStoredHash(localPath: string, tx: Tx): void {
  tx.delete(fileHashes).where(eq(fileHashes.localPath, localPath)).run();
}

/**
 * Delete all stored hashes under a directory path.
 * Used when a directory is deleted.
 */
export function deleteStoredHashesUnderPath(dirPath: string, tx: Tx): void {
  const pathPrefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  tx.delete(fileHashes)
    .where(like(fileHashes.localPath, `${pathPrefix}%`))
    .run();
}

/**
 * Remove hashes for paths no longer under any sync directory.
 */
export function cleanupOrphanedHashes(tx: Tx): number {
  const config = getConfig();
  const syncDirs = config.sync_dirs;

  if (syncDirs.length === 0) {
    // No sync dirs configured, clear all hashes
    tx.delete(fileHashes).run();
    return 0;
  }

  // Get all hashes
  const allHashes = tx.select().from(fileHashes).all();
  let removedCount = 0;

  for (const hash of allHashes) {
    const isUnderSyncDir = syncDirs.some(
      (dir) =>
        hash.localPath === dir.source_path || hash.localPath.startsWith(`${dir.source_path}/`)
    );

    if (!isUnderSyncDir) {
      tx.delete(fileHashes).where(eq(fileHashes.localPath, hash.localPath)).run();
      removedCount++;
    }
  }

  return removedCount;
}
