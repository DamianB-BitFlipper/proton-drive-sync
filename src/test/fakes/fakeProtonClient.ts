import type { DownloadController, FileDownloader, ProtonDriveClient } from '../../proton/types.js';

export class FakeProtonClient implements Pick<ProtonDriveClient, 'getFileDownloader'> {
  requestedNodeUids: string[] = [];

  constructor(private readonly content: Uint8Array) {}

  async getFileDownloader(nodeUid: string): Promise<FileDownloader> {
    this.requestedNodeUids.push(nodeUid);
    return new FakeFileDownloader(this.content);
  }
}

class FakeFileDownloader implements FileDownloader {
  constructor(private readonly content: Uint8Array) {}

  getClaimedSizeInBytes(): number {
    return this.content.byteLength;
  }

  downloadToStream(stream: WritableStream<Uint8Array>): DownloadController {
    const completion = (async () => {
      const writer = stream.getWriter();
      await writer.write(this.content);
      await writer.close();
    })();

    return {
      pause(): void {},
      resume(): void {},
      completion: () => completion,
    };
  }
}
