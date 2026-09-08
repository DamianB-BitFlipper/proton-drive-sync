/**
 * Resync Command - Force one file to resync using local content as the source of truth.
 *
 * Breaks a stuck sync loop (e.g. a stale tracked remote baseline causing repeated
 * merge/upload cycles) by clearing the tracked remote state for one path,
 * resolving any dangling conflict, and queuing a fresh upload.
 */

import { resolve } from 'path';
import { stat } from 'fs/promises';
import { confirm } from '@inquirer/prompts';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import { enqueueJob } from '../sync/queue.js';
import { deleteBaseSnapshot } from '../sync/baseSnapshots.js';
import { listOpenConflicts, resolveConflict } from '../sync/conflicts.js';

export async function resyncCommand(
  path: string,
  options: { local?: boolean; yes?: boolean }
): Promise<void> {
  if (!options.local) {
    throw new Error('Specify --local to force the local version to win.');
  }

  const localPath = resolve(path);
  const mapping = db
    .select()
    .from(schema.nodeMapping)
    .where(eq(schema.nodeMapping.localPath, localPath))
    .get();

  if (!mapping) {
    throw new Error(`No tracked sync mapping found for: ${localPath}`);
  }
  if (mapping.isDirectory) {
    throw new Error('resync --local only supports files, not directories.');
  }

  const fileStat = await stat(localPath);

  if (!options.yes) {
    const confirmed = await confirm({
      message: `This clears the tracked remote state for "${localPath}" and force-uploads it, overwriting the remote version. Continue?`,
      default: false,
    });
    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  }

  const openConflict = listOpenConflicts().find((c) => c.localPath === localPath);

  db.transaction((tx) => {
    // Drop the stale remote baseline so the echo of this upload isn't
    // mistaken for an incoming remote change and re-triggers the loop.
    tx.update(schema.nodeMapping)
      .set({ remoteRevisionUid: null, remoteSha1: null, remoteModifiedAt: null })
      .where(eq(schema.nodeMapping.localPath, localPath))
      .run();

    tx.delete(schema.syncJobs).where(eq(schema.syncJobs.localPath, localPath)).run();
    tx.delete(schema.processingQueue).where(eq(schema.processingQueue.localPath, localPath)).run();

    if (openConflict) resolveConflict(openConflict.id, tx);

    enqueueJob(
      {
        eventType: SyncEventType.UPDATE,
        localPath,
        remotePath: mapping.remotePath,
        changeToken: `${fileStat.mtimeMs}:${fileStat.size}`,
      },
      false,
      tx
    );
  });

  await deleteBaseSnapshot(localPath);

  logger.info(`Queued forced upload of ${localPath} -> ${mapping.remotePath}.`);
  logger.info('Start (or resume) the daemon if it is not already running to pick this up.');
}
