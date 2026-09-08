/**
 * Proton Drive file download helpers.
 */

import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { ProtonDriveClient } from './types.js';

/**
 * Download a decrypted and integrity-checked remote file to a local path.
 */
export async function downloadNode(
  client: Pick<ProtonDriveClient, 'getFileDownloader'>,
  nodeUid: string,
  localPath: string,
  onProgress?: (downloadedBytes: number) => void
): Promise<void> {
  const downloader = await client.getFileDownloader(nodeUid);
  await mkdir(dirname(localPath), { recursive: true });
  const writer = Bun.file(localPath).writer();
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      writer.write(chunk);
    },
    close() {
      writer.end();
    },
    abort() {
      writer.end();
    },
  });

  try {
    const controller = downloader.downloadToStream(stream, onProgress);
    await controller.completion();
  } catch (error) {
    writer.end();
    throw error;
  }
}
