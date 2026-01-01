/**
 * Proton Drive - Relocate Operations
 *
 * Relocates (moves and/or renames) files and directories on Proton Drive.
 */

import type { ProtonDriveClient } from './types.js';
import { parsePath, findFolderByName } from './utils.js';

// ============================================================================
// Types
// ============================================================================

export interface RelocateResult {
  success: boolean;
  nodeUid?: string;
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Resolve a remote path to the parent folder's nodeUid.
 */
async function resolveParentFolderUid(
  client: ProtonDriveClient,
  remotePath: string
): Promise<string> {
  const { parentParts } = parsePath(remotePath);

  const rootFolder = await client.getMyFilesRootFolder();
  if (!rootFolder.ok) {
    throw new Error(`Failed to get root folder: ${rootFolder.error}`);
  }

  let currentFolderUid = rootFolder.value!.uid;

  for (const folderName of parentParts) {
    const folderUid = await findFolderByName(client, currentFolderUid, folderName);
    if (!folderUid) {
      throw new Error(`Parent folder not found: ${folderName}`);
    }
    currentFolderUid = folderUid;
  }

  return currentFolderUid;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Relocate a node on Proton Drive (move and/or rename).
 *
 * This is a unified function that handles:
 * - Rename only: same parent, different name (provide only `newName`)
 * - Move only: different parent, same name (provide only `newParentNodeUid`)
 * - Move and rename: different parent and name (provide both)
 *
 * @param client - The Proton Drive client
 * @param nodeUid - The UID of the node to relocate
 * @param options.newParentNodeUid - The UID of the new parent folder (for moves)
 * @param options.newName - The new name for the node (for renames)
 * @returns RelocateResult with success status
 */
export async function relocateNode(
  client: ProtonDriveClient,
  nodeUid: string,
  options: { newParentNodeUid?: string; newName?: string }
): Promise<RelocateResult> {
  const { newParentNodeUid, newName } = options;

  if (!newParentNodeUid && !newName) {
    return {
      success: false,
      error: 'At least one of newParentNodeUid or newName must be provided',
    };
  }

  try {
    // Move to new parent if specified
    if (newParentNodeUid) {
      for await (const result of client.moveNodes([nodeUid], newParentNodeUid)) {
        if (!result.ok) {
          return {
            success: false,
            error: `Failed to move node: ${result.error}`,
          };
        }
      }
    }

    // Rename if specified
    if (newName) {
      const result = await client.renameNode(nodeUid, newName);
      if (!result.ok) {
        const errorPrefix = newParentNodeUid
          ? 'Move succeeded but rename failed'
          : 'Failed to rename node';
        return {
          success: false,
          error: `${errorPrefix}: ${result.error}`,
        };
      }
    }

    return {
      success: true,
      nodeUid,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Resolve the parent folder UID for a remote path.
 * Useful for getting the new parent when processing MOVE events.
 *
 * @param client - The Proton Drive client
 * @param remotePath - The remote path (e.g., "backup/folder/file.txt")
 * @returns The parent folder's nodeUid
 */
export async function getParentFolderUid(
  client: ProtonDriveClient,
  remotePath: string
): Promise<string> {
  return resolveParentFolderUid(client, remotePath);
}
