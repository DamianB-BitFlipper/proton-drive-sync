import { copyFile, rm } from 'fs/promises';
import { db } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { enqueueJob } from '../sync/queue.js';
import { getConflict, listOpenConflicts, resolveConflict } from '../sync/conflicts.js';

export async function conflictsCommand(options: {
  resolve?: string;
  local?: boolean;
  remote?: boolean;
  retry?: string;
}): Promise<void> {
  if (options.retry) {
    const conflict = getConflict(Number(options.retry));
    if (!conflict || conflict.status !== 'OPEN') {
      throw new Error(`Open conflict not found: ${options.retry}`);
    }
    await copyFile(conflict.conflictPath, conflict.localPath);
    db.transaction((tx) => {
      enqueueJob(
        {
          eventType: SyncEventType.MERGE_FILE,
          localPath: conflict.localPath,
          remotePath: conflict.remotePath,
          changeToken: null,
        },
        false,
        tx
      );
    });
    console.log(`Retry queued for conflict ${conflict.id}.`);
    return;
  }

  if (!options.resolve) {
    console.log(JSON.stringify(listOpenConflicts(), null, 2));
    return;
  }

  const conflict = getConflict(Number(options.resolve));
  if (!conflict || conflict.status !== 'OPEN') {
    throw new Error(`Open conflict not found: ${options.resolve}`);
  }
  if (options.local === options.remote) {
    throw new Error('Choose exactly one resolution: --local or --remote');
  }

  if (options.local) {
    await copyFile(conflict.conflictPath, conflict.localPath);
    db.transaction((tx) => {
      enqueueJob(
        {
          eventType: SyncEventType.UPDATE,
          localPath: conflict.localPath,
          remotePath: conflict.remotePath,
          changeToken: null,
        },
        false,
        tx
      );
      resolveConflict(conflict.id, tx);
    });
  } else {
    await rm(conflict.conflictPath, { force: true });
    if (conflict.remoteDeleted) {
      await rm(conflict.localPath, { force: true });
    }
    db.transaction((tx) => resolveConflict(conflict.id, tx));
  }
  console.log(`Resolved conflict ${conflict.id} using ${options.local ? 'local' : 'remote'}.`);
}
