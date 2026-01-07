/**
 * Proton Drive Sync - Node Mapping Storage
 *
 * Tracks the mapping between local paths and Proton Drive nodeUids.
 * Used to support efficient rename/move operations without re-uploading.
 */

import { and, eq, like } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { nodeMapping } from '../db/schema.js';
import { getConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

export interface NodeMappingInfo {
  nodeUid: string;
  parentNodeUid: string;
  isDirectory: boolean;
}

// ============================================================================
// Node Mapping CRUD
// ============================================================================

/**
 * Get the node mapping for a local path and remote path.
 */
export function getNodeMapping(
  localPath: string,
  remotePath: string,
  tx?: Tx
): NodeMappingInfo | null {
  const target = tx ?? db;
  const result = target
    .select()
    .from(nodeMapping)
    .where(and(eq(nodeMapping.localPath, localPath), eq(nodeMapping.remotePath, remotePath)))
    .get();
  if (!result) return null;
  return {
    nodeUid: result.nodeUid,
    parentNodeUid: result.parentNodeUid,
    isDirectory: result.isDirectory,
  };
}

/**
 * Store or update the node mapping for a local path and remote path.
 */
export function setNodeMapping(
  localPath: string,
  remotePath: string,
  nodeUid: string,
  parentNodeUid: string,
  isDirectory: boolean,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  tx.insert(nodeMapping)
    .values({
      localPath,
      remotePath,
      nodeUid,
      parentNodeUid,
      isDirectory,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [nodeMapping.localPath, nodeMapping.remotePath],
      set: {
        nodeUid,
        parentNodeUid,
        isDirectory,
        updatedAt: new Date(),
      },
    })
    .run();
}

/**
 * Delete the node mapping for a local path and remote path.
 */
export function deleteNodeMapping(
  localPath: string,
  remotePath: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  tx.delete(nodeMapping)
    .where(and(eq(nodeMapping.localPath, localPath), eq(nodeMapping.remotePath, remotePath)))
    .run();
}

/**
 * Delete all node mappings under a directory path for a specific remote root.
 * Used when a directory is deleted.
 */
export function deleteNodeMappingsUnderPath(dirPath: string, remoteRoot: string, tx: Tx): void {
  const pathPrefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`;
  const remotePrefix = remoteRoot.endsWith('/') ? remoteRoot : `${remoteRoot}/`;
  tx.delete(nodeMapping)
    .where(
      and(
        like(nodeMapping.localPath, `${pathPrefix}%`),
        like(nodeMapping.remotePath, `${remotePrefix}%`)
      )
    )
    .run();
}

/**
 * Update the path for a node mapping (used after rename/move).
 */
export function updateNodeMappingPath(
  oldLocalPath: string,
  oldRemotePath: string,
  newLocalPath: string,
  newRemotePath: string,
  newParentNodeUid: string | undefined,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;

  // Get existing mapping
  const existing = tx
    .select()
    .from(nodeMapping)
    .where(and(eq(nodeMapping.localPath, oldLocalPath), eq(nodeMapping.remotePath, oldRemotePath)))
    .get();

  if (!existing) return;

  // Delete old mapping and insert new one (since we're changing primary key)
  tx.delete(nodeMapping)
    .where(and(eq(nodeMapping.localPath, oldLocalPath), eq(nodeMapping.remotePath, oldRemotePath)))
    .run();

  tx.insert(nodeMapping)
    .values({
      localPath: newLocalPath,
      remotePath: newRemotePath,
      nodeUid: existing.nodeUid,
      parentNodeUid: newParentNodeUid ?? existing.parentNodeUid,
      isDirectory: existing.isDirectory,
      updatedAt: new Date(),
    })
    .run();
}

/**
 * Update all node mappings under a directory when the directory is renamed.
 * Replaces oldDirPath prefix with newDirPath for all children.
 */
export function updateNodeMappingsUnderPath(
  oldDirPath: string,
  oldRemoteRoot: string,
  newDirPath: string,
  newRemoteRoot: string,
  dryRun: boolean,
  tx: Tx
): void {
  if (dryRun) return;
  const localPrefix = oldDirPath.endsWith('/') ? oldDirPath : `${oldDirPath}/`;
  const remotePrefix = oldRemoteRoot.endsWith('/') ? oldRemoteRoot : `${oldRemoteRoot}/`;

  const children = tx
    .select()
    .from(nodeMapping)
    .where(
      and(
        like(nodeMapping.localPath, `${localPrefix}%`),
        like(nodeMapping.remotePath, `${remotePrefix}%`)
      )
    )
    .all();

  for (const child of children) {
    const newLocalPath = newDirPath + child.localPath.slice(oldDirPath.length);
    const newRemotePath = newRemoteRoot + child.remotePath.slice(oldRemoteRoot.length);

    // Delete old and insert new (changing primary key)
    tx.delete(nodeMapping)
      .where(
        and(
          eq(nodeMapping.localPath, child.localPath),
          eq(nodeMapping.remotePath, child.remotePath)
        )
      )
      .run();

    tx.insert(nodeMapping)
      .values({
        localPath: newLocalPath,
        remotePath: newRemotePath,
        nodeUid: child.nodeUid,
        parentNodeUid: child.parentNodeUid,
        isDirectory: child.isDirectory,
        updatedAt: new Date(),
      })
      .run();
  }
}

/**
 * Remove node mappings for paths no longer under any valid sync directory + remote root pair.
 */
export function cleanupOrphanedNodeMappings(tx: Tx): number {
  const config = getConfig();
  const syncDirs = config.sync_dirs;

  if (syncDirs.length === 0) {
    // No sync dirs configured, clear all mappings
    tx.delete(nodeMapping).run();
    return 0;
  }

  // Get all mappings
  const allMappings = tx.select().from(nodeMapping).all();
  let removedCount = 0;

  for (const mapping of allMappings) {
    // Check if this (localPath, remotePath) pair is valid for any sync_dir
    const isValidPair = syncDirs.some((dir) => {
      const localMatch =
        mapping.localPath === dir.source_path ||
        mapping.localPath.startsWith(`${dir.source_path}/`);
      const remoteMatch =
        mapping.remotePath === dir.remote_root ||
        mapping.remotePath.startsWith(`${dir.remote_root}/`);
      return localMatch && remoteMatch;
    });

    if (!isValidPair) {
      tx.delete(nodeMapping)
        .where(
          and(
            eq(nodeMapping.localPath, mapping.localPath),
            eq(nodeMapping.remotePath, mapping.remotePath)
          )
        )
        .run();
      removedCount++;
    }
  }

  return removedCount;
}
