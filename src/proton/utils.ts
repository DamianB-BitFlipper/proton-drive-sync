/**
 * Proton Drive - Shared Utilities
 *
 * Helper functions used across create and delete operations.
 * Types are imported from types.ts.
 */

import { basename, dirname } from 'path';
import type { BaseProtonDriveClient, NodeData, ParsedPath } from './types.js';

// Re-export types for convenience
export type { BaseProtonDriveClient, ParsedPath } from './types.js';

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Parse a path and return its components.
 * Strips my_files/ prefix if present.
 * Returns { parentParts: string[], name: string }
 */
export function parsePath(localPath: string): ParsedPath {
  let relativePath = localPath;

  // Strip my_files/ prefix if present
  if (relativePath.startsWith('my_files/')) {
    relativePath = relativePath.slice('my_files/'.length);
  } else if (relativePath.startsWith('./my_files/')) {
    relativePath = relativePath.slice('./my_files/'.length);
  }

  // Remove trailing slash for directories
  if (relativePath.endsWith('/')) {
    relativePath = relativePath.slice(0, -1);
  }

  const name = basename(relativePath);
  const dirPath = dirname(relativePath);

  // If there's no directory (item is at root), return empty array
  if (dirPath === '.' || dirPath === '') {
    return { parentParts: [], name };
  }

  // Split by / to get folder components
  const parentParts = dirPath.split('/').filter((part) => part.length > 0);
  return { parentParts, name };
}

// ============================================================================
// Node Finding Utilities
// ============================================================================

/**
 * Find a node (file or folder) by name in a parent folder.
 * Returns { uid, type } if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
export async function findNodeByName(
  client: BaseProtonDriveClient,
  parentFolderUid: string,
  name: string
): Promise<{ uid: string; type: string } | null> {
  let found: { uid: string; type: string } | null = null;
  for await (const node of client.iterateFolderChildren(parentFolderUid)) {
    if (!found && node.ok && node.value?.name === name) {
      found = { uid: node.value.uid, type: node.value.type };
    }
  }
  return found;
}

/**
 * Find an existing file by name in a folder.
 * Returns the node info if found, null otherwise.
 */
export async function findFileByName(
  client: BaseProtonDriveClient,
  folderUid: string,
  fileName: string
): Promise<NodeData | null> {
  let found: NodeData | null = null;
  for await (const node of client.iterateFolderChildren(folderUid)) {
    if (!found && node.ok && node.value?.name === fileName && node.value.type === 'file') {
      const nodeValue = node.value as NodeData;
      const activeRev = nodeValue.activeRevision;

      // Use claimedSize (original file size) for comparison, not storageSize (encrypted size)
      const size = activeRev?.claimedSize ?? nodeValue.totalStorageSize ?? undefined;
      const updatedAt = activeRev?.claimedModificationTime ?? nodeValue.creationTime ?? undefined;

      found = {
        ...nodeValue,
        size,
        updatedAt,
      };
    }
  }
  return found;
}

/**
 * Find a folder by name in a parent folder.
 * Returns the folder UID if found, null otherwise.
 */
export async function findFolderByName(
  client: BaseProtonDriveClient,
  parentFolderUid: string,
  folderName: string
): Promise<string | null> {
  let foundUid: string | null = null;
  for await (const node of client.iterateFolderChildren(parentFolderUid)) {
    if (!foundUid && node.ok && node.value?.type === 'folder' && node.value.name === folderName) {
      foundUid = node.value.uid;
    }
  }
  return foundUid;
}

// ============================================================================
// Path Traversal Utilities
// ============================================================================

/**
 * Traverse the remote path and return the UID of the target folder.
 * Returns null if any part of the path doesn't exist.
 */
export async function traverseRemotePath(
  client: BaseProtonDriveClient,
  rootFolderUid: string,
  pathParts: string[]
): Promise<string | null> {
  let currentFolderUid = rootFolderUid;

  for (const folderName of pathParts) {
    const node = await findNodeByName(client, currentFolderUid, folderName);

    if (!node) {
      return null;
    }

    if (node.type !== 'folder') {
      return null;
    }

    currentFolderUid = node.uid;
  }

  return currentFolderUid;
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format bytes into human-readable size string
 */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let size = bytes;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}
