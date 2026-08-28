import { createHash } from 'crypto';
import { copyFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { baseSnapshots } from '../db/schema.js';
import { getStateDir } from '../paths.js';

export interface BaseSnapshot {
  localPath: string;
  snapshotPath: string;
  localSha1: string;
  remoteRevisionUid: string | null;
  remoteSha1: string | null;
}

function snapshotPath(localPath: string): string {
  const id = createHash('sha256').update(localPath).digest('hex');
  return join(getStateDir(), 'base-snapshots', `${id}.base`);
}

export function getBaseSnapshot(localPath: string): BaseSnapshot | null {
  const result = db
    .select()
    .from(baseSnapshots)
    .where(eq(baseSnapshots.localPath, localPath))
    .get();
  return result ?? null;
}

export async function saveBaseSnapshot(
  localPath: string,
  localSha1: string,
  remoteRevisionUid: string | null,
  remoteSha1: string | null
): Promise<void> {
  const destination = snapshotPath(localPath);
  await mkdir(join(getStateDir(), 'base-snapshots'), { recursive: true });
  await copyFile(localPath, destination);
  db.transaction((tx) => {
    tx.insert(baseSnapshots)
      .values({
        localPath,
        snapshotPath: destination,
        localSha1,
        remoteRevisionUid,
        remoteSha1,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: baseSnapshots.localPath,
        set: {
          snapshotPath: destination,
          localSha1,
          remoteRevisionUid,
          remoteSha1,
          updatedAt: new Date(),
        },
      })
      .run();
  });
}

export async function deleteBaseSnapshot(localPath: string): Promise<void> {
  const snapshot = getBaseSnapshot(localPath);
  if (snapshot) await rm(snapshot.snapshotPath, { force: true });
  db.delete(baseSnapshots).where(eq(baseSnapshots.localPath, localPath)).run();
}
