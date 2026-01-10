/**
 * Proton Drive - Delete File or Directory
 *
 * Deletes a file or directory from Proton Drive.
 * - Pass a path (e.g., my_files/foo/bar.txt) and the corresponding remote item is deleted.
 * - If the remote item doesn't exist, does nothing (noop).
 * - By default, moves to trash only (recoverable).
 * - If trashOnly is false, permanently deletes (trash first, then delete from trash).
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 */

import type { DeleteProtonDriveClient, DeleteOperationResult } from './types.js';
import { parsePath, findNodeByName, traverseRemotePath } from './utils.js';

// Re-export the client type for backwards compatibility
export type { DeleteProtonDriveClient, DeleteOperationResult } from './types.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Delete a file or directory from Proton Drive.
 *
 * @param client - The Proton Drive client
 * @param remotePath - The remote path (e.g., "my_files/foo/bar.txt")
 * @param dryRun - If true, skip network calls and return dummy result
 * @param trashOnly - If true, only move to trash (recoverable). If false, permanently delete.
 * @returns DeleteOperationResult with success status and whether it was trashed or permanently deleted
 */
export async function deleteNode(
  client: DeleteProtonDriveClient,
  remotePath: string,
  dryRun = false,
  trashOnly = true
): Promise<DeleteOperationResult> {
  if (dryRun) {
    return { success: true, existed: false, trashed: trashOnly };
  }
  const { parentParts, name } = parsePath(remotePath);

  // Get root folder
  const rootFolder = await client.getMyFilesRootFolder();

  if (!rootFolder.ok || !rootFolder.value) {
    return {
      success: false,
      existed: false,
      trashed: false,
      error: `Failed to get root folder: ${rootFolder.error}`,
    };
  }

  const rootFolderUid = rootFolder.value.uid;

  // Traverse to parent folder
  let targetFolderUid = rootFolderUid;

  if (parentParts.length > 0) {
    const traverseResult = await traverseRemotePath(client, rootFolderUid, parentParts);

    if (!traverseResult) {
      return { success: true, existed: false, trashed: false };
    }

    targetFolderUid = traverseResult;
  }

  // Find the target node
  const targetNode = await findNodeByName(client, targetFolderUid, name);

  if (!targetNode) {
    return { success: true, existed: false, trashed: false };
  }

  // Delete the node
  try {
    // Step 1: Move to trash (gracefully handle if already trashed)
    try {
      for await (const result of client.trashNodes([targetNode.uid])) {
        if (!result.ok) {
          const errorStr = String(result.error).toLowerCase();
          // Continue if already trashed
          if (!errorStr.includes('already') && !errorStr.includes('trashed')) {
            throw new Error(`Failed to trash: ${result.error}`);
          }
        }
      }
    } catch (trashError) {
      const errorStr = String(trashError).toLowerCase();
      // If already trashed, continue to deletion step
      if (!errorStr.includes('already') && !errorStr.includes('trashed')) {
        throw trashError;
      }
    }

    // Step 2: Permanently delete from trash (only if not trashOnly)
    if (!trashOnly) {
      for await (const result of client.deleteNodes([targetNode.uid])) {
        if (!result.ok) {
          throw new Error(`Failed to delete: ${result.error}`);
        }
      }
    }

    return {
      success: true,
      existed: true,
      trashed: trashOnly,
      nodeUid: targetNode.uid,
      nodeType: targetNode.type,
    };
  } catch (error) {
    return {
      success: false,
      existed: true,
      trashed: trashOnly,
      nodeUid: targetNode.uid,
      nodeType: targetNode.type,
      error: (error as Error).message,
    };
  }
}
