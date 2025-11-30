/**
 * Proton Drive - Delete File or Directory
 *
 * Deletes a file or directory from Proton Drive.
 * - Pass a path (e.g., my_files/foo/bar.txt) and the corresponding remote item is deleted.
 * - If the remote item doesn't exist, does nothing (noop).
 * - By default, moves to trash. Use permanent=true to delete permanently.
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
 * @param permanent - If true, permanently delete; if false, move to trash (default)
 * @returns DeleteOperationResult with success status
 */
export async function deleteNode(
    client: DeleteProtonDriveClient,
    remotePath: string,
    permanent: boolean = false
): Promise<DeleteOperationResult> {
    const { parentParts, name } = parsePath(remotePath);

    console.log(`Deleting from remote: ${remotePath}`);
    console.log(`  Mode: ${permanent ? 'permanent delete' : 'move to trash'}`);

    // Get root folder
    const rootFolder = await client.getMyFilesRootFolder();

    if (!rootFolder.ok) {
        return {
            success: false,
            existed: false,
            error: `Failed to get root folder: ${rootFolder.error}`,
        };
    }

    const rootFolderUid = rootFolder.value!.uid;

    // Traverse to parent folder
    let targetFolderUid = rootFolderUid;

    if (parentParts.length > 0) {
        console.log(`Traversing path: ${parentParts.join('/')}`);
        const traverseResult = await traverseRemotePath(client, rootFolderUid, parentParts);

        if (!traverseResult) {
            console.log('Path does not exist on remote. Nothing to delete.');
            return { success: true, existed: false };
        }

        targetFolderUid = traverseResult;
    }

    // Find the target node
    console.log(`Looking for "${name}"...`);
    const targetNode = await findNodeByName(client, targetFolderUid, name);

    if (!targetNode) {
        console.log(`"${name}" does not exist on remote. Nothing to delete.`);
        return { success: true, existed: false };
    }

    console.log(`Found ${targetNode.type}: ${name} (${targetNode.uid})`);

    // Delete or trash the node
    try {
        if (permanent) {
            console.log(`Permanently deleting...`);
            for await (const result of client.deleteNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to delete: ${result.error}`);
                }
            }
            console.log(`Permanently deleted!`);
        } else {
            console.log(`Moving to trash...`);
            for await (const result of client.trashNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to trash: ${result.error}`);
                }
            }
            console.log(`Moved to trash!`);
        }

        return {
            success: true,
            existed: true,
            nodeUid: targetNode.uid,
            nodeType: targetNode.type,
        };
    } catch (error) {
        return {
            success: false,
            existed: true,
            nodeUid: targetNode.uid,
            nodeType: targetNode.type,
            error: (error as Error).message,
        };
    }
}
