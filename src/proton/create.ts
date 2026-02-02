/**
 * Proton Drive - Create File or Directory
 *
 * Creates a file or directory on Proton Drive.
 * - For files: uploads the file content. If the file exists, creates a new revision.
 * - For directories: creates an empty directory. If it exists, does nothing.
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 * - Parent directories are created automatically if they don't exist.
 */

import { statSync, type Stats } from 'fs';
import { createHash } from 'crypto';
import type {
  CreateProtonDriveClient,
  UploadMetadata,
  UploadController,
  CreateResult,
} from './types.js';
import { parsePath, findFileByName, findFolderByName } from './utils.js';
import { logger } from '../logger.js';

// Re-export the client type for backwards compatibility
export type { CreateProtonDriveClient, CreateResult } from './types.js';

// ============================================================================
// Path Creation
// ============================================================================

/**
 * Ensure all directories in the path exist, creating them if necessary.
 * Returns the UID of the final (deepest) folder.
 *
 * This is O(d) API calls where d = path depth, which is unavoidable for tree traversal.
 * Once we need to create a folder, all subsequent folders must be created (no more searching).
 */
async function ensureRemotePath(
  client: CreateProtonDriveClient,
  rootFolderUid: string,
  pathParts: string[]
): Promise<string> {
  let currentFolderUid = rootFolderUid;
  let needToCreate = false;

  for (const folderName of pathParts) {
    if (needToCreate) {
      // Once we start creating, all subsequent folders need to be created
      const result = await client.createFolder(currentFolderUid, folderName);
      if (!result.ok || !result.value) {
        throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
      }
      currentFolderUid = result.value.uid;
    } else {
      // Search for existing folder
      const existingFolderUid = await findFolderByName(client, currentFolderUid, folderName);

      if (existingFolderUid) {
        currentFolderUid = existingFolderUid;
      } else {
        // Folder doesn't exist, create it and all subsequent folders
        const result = await client.createFolder(currentFolderUid, folderName);
        if (!result.ok || !result.value) {
          throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
        }
        currentFolderUid = result.value.uid;
        needToCreate = true; // All subsequent folders must be created
      }
    }
  }

  return currentFolderUid;
}

// ============================================================================
// Hash Utilities
// ============================================================================

/**
 * Compute SHA1 hash of a local file
 */
async function computeFileSha1(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    const hash = createHash('sha1').update(Buffer.from(buffer)).digest('hex');
    return hash;
  } catch (error) {
    logger.warn(`Failed to compute SHA1 for ${filePath}: ${error}`);
    return null;
  }
}

// ============================================================================
// File Upload
// ============================================================================

async function uploadFile(
  client: CreateProtonDriveClient,
  targetFolderUid: string,
  localFilePath: string,
  fileName: string,
  fileStat: Stats
): Promise<string> {
  const fileSize = Number(fileStat.size);

  // Check if file already exists in the target folder
  const existingFile = await findFileByName(client, targetFolderUid, fileName);

  const metadata: UploadMetadata = {
    mediaType: 'application/octet-stream',
    expectedSize: fileSize,
    modificationTime: fileStat.mtime,
    overrideExistingDraftByOtherClient: true,
  };

  let uploadController: UploadController;

  if (existingFile) {
    // Compare files using SHA1 digest if available, otherwise fall back to size+mtime
    try {
      const remoteSha1 = existingFile.claimedDigests?.sha1;
      const localMtime = fileStat.mtime.getTime();
      const remoteMtime = existingFile.updatedAt
        ? new Date(existingFile.updatedAt).getTime()
        : undefined;

      logger.info(
        `Remote file check for ${fileName}: ` +
          `remoteSha1=${remoteSha1 || 'none'}, ` +
          `remoteMtime=${remoteMtime}, localMtime=${localMtime}`
      );

      if (remoteSha1) {
        // Compare using SHA1 digest - most reliable method
        const localSha1 = await computeFileSha1(localFilePath);
        logger.info(`SHA1 comparison for ${fileName}: remote=${remoteSha1}, local=${localSha1}`);

        if (localSha1 && localSha1.toLowerCase() === remoteSha1.toLowerCase()) {
          // SHA1 matches - files are identical, skip upload
          logger.info(`Skipping upload for ${fileName} - SHA1 digests match`);
          return existingFile.uid;
        }

        // SHA1 doesn't match - only upload if local file is newer
        if (remoteMtime !== undefined) {
          if (localMtime <= remoteMtime) {
            logger.info(
              `Skipping upload for ${fileName} - SHA1 differs but local file is older or same age ` +
                `(local: ${localMtime}, remote: ${remoteMtime})`
            );
            return existingFile.uid;
          } else {
            logger.info(
              `Uploading new revision for ${fileName} - SHA1 differs and local file is newer ` +
                `(local: ${localMtime}, remote: ${remoteMtime})`
            );
          }
        }
      } else {
        // No SHA1 available, fall back to size + mtime comparison
        const remoteSize = typeof existingFile.size === 'number' ? existingFile.size : undefined;
        logger.info(
          `Fallback comparison for ${fileName}: ` +
            `remoteSize=${remoteSize}, localSize=${fileSize}, ` +
            `remoteMtime=${remoteMtime}, localMtime=${localMtime}`
        );

        if (remoteSize !== undefined && remoteMtime !== undefined) {
          const sizeMatch = remoteSize === fileSize;
          const mtimeMatch = Math.abs(remoteMtime - localMtime) <= 1000;

          logger.info(
            `Fallback check for ${fileName}: sizeMatch=${sizeMatch}, mtimeMatch=${mtimeMatch}`
          );

          if (sizeMatch && mtimeMatch) {
            logger.info(`Skipping upload for ${fileName} - size and mtime match`);
            return existingFile.uid;
          }

          // If size/mtime differ, only upload if local is newer
          if (localMtime <= remoteMtime) {
            logger.info(
              `Skipping upload for ${fileName} - size/mtime differ but local is older/same`
            );
            return existingFile.uid;
          }
        }
      }
    } catch (error) {
      // If metadata parsing fails, fall through to uploading a revision
      logger.warn(`Failed to compare remote metadata for ${fileName}: ${error}`);
    }

    const revisionUploader = await client.getFileRevisionUploader(existingFile.uid, metadata);
    const webStream = Bun.file(localFilePath).stream();
    uploadController = await revisionUploader.uploadFromStream(webStream, []);
  } else {
    const fileUploader = await client.getFileUploader(targetFolderUid, fileName, metadata);
    const webStream = Bun.file(localFilePath).stream();
    uploadController = await fileUploader.uploadFromStream(webStream, []);
  }

  // Wait for completion
  const { nodeUid } = await uploadController.completion();
  return nodeUid;
}

// ============================================================================
// Directory Creation
// ============================================================================

async function createDirectory(
  client: CreateProtonDriveClient,
  targetFolderUid: string,
  dirName: string,
  modificationTime?: Date
): Promise<string> {
  // Check if directory already exists
  const existingFolderUid = await findFolderByName(client, targetFolderUid, dirName);

  if (existingFolderUid) {
    return existingFolderUid;
  } else {
    const result = await client.createFolder(targetFolderUid, dirName, modificationTime);
    if (!result.ok || !result.value) {
      throw new Error(`Failed to create directory "${dirName}": ${result.error}`);
    }
    return result.value.uid;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a file or directory on Proton Drive.
 *
 * @param client - The Proton Drive client
 * @param localPath - The local file path to read from (e.g., "/Users/foo/my_files/bar.txt")
 * @param remotePath - The remote path on Proton Drive (e.g., "backup/my_files/bar.txt")
 * @param dryRun - If true, skip network calls and return dummy result
 * @returns CreateResult with success status and node UID
 */
export async function createNode(
  client: CreateProtonDriveClient,
  localPath: string,
  remotePath: string,
  dryRun = false
): Promise<CreateResult> {
  if (dryRun) {
    return {
      success: true,
      nodeUid: 'dry-run-node-uid',
      parentNodeUid: 'dry-run-parent-uid',
      isDirectory: false,
    };
  }
  // Check if path exists locally
  let pathStat: Stats | null = null;
  let isDirectory = false;

  try {
    pathStat = statSync(localPath);
    isDirectory = pathStat.isDirectory();
  } catch {
    // Path doesn't exist locally - treat as directory creation if ends with /
    if (remotePath.endsWith('/')) {
      isDirectory = true;
    } else {
      return {
        success: false,
        error: `Local path not found: ${localPath}. For creating a new directory, add a trailing slash to remotePath.`,
        isDirectory: false,
      };
    }
  }

  const { parentParts, name } = parsePath(remotePath);

  // Get root folder
  const rootFolder = await client.getMyFilesRootFolder();

  if (!rootFolder.ok || !rootFolder.value) {
    return {
      success: false,
      error: `Failed to get root folder: ${rootFolder.error}`,
      isDirectory,
    };
  }

  const rootFolderUid = rootFolder.value.uid;

  // Ensure parent directories exist
  let targetFolderUid = rootFolderUid;

  if (parentParts.length > 0) {
    targetFolderUid = await ensureRemotePath(client, rootFolderUid, parentParts);
  }

  // Create file or directory
  try {
    if (isDirectory) {
      const nodeUid = await createDirectory(client, targetFolderUid, name, pathStat?.mtime);
      return { success: true, nodeUid, parentNodeUid: targetFolderUid, isDirectory: true };
    } else {
      if (!pathStat) {
        return {
          success: false,
          error: `Cannot upload file: stat unavailable for ${localPath}`,
          isDirectory: false,
        };
      }
      const nodeUid = await uploadFile(client, targetFolderUid, localPath, name, pathStat);
      return { success: true, nodeUid, parentNodeUid: targetFolderUid, isDirectory: false };
    }
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
      isDirectory,
    };
  }
}
