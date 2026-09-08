import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { conflicts } from '../db/schema.js';

export interface ConflictInfo {
  id: number;
  localPath: string;
  remotePath: string;
  localSha1: string;
  remoteRevisionUid: string | null;
  remoteSha1: string | null;
  remoteDeleted: boolean;
  conflictPath: string;
  status: string;
}

export function createConflict(params: Omit<ConflictInfo, 'id' | 'status'>, tx: Tx): ConflictInfo {
  const result = tx
    .insert(conflicts)
    .values({ ...params, status: 'OPEN', createdAt: new Date() })
    .returning()
    .get();
  return result;
}

export function listOpenConflicts(): ConflictInfo[] {
  return db.select().from(conflicts).where(eq(conflicts.status, 'OPEN')).all();
}

export function getConflict(id: number): ConflictInfo | null {
  return db.select().from(conflicts).where(eq(conflicts.id, id)).get() ?? null;
}

export function resolveConflict(id: number, tx: Tx): void {
  tx.update(conflicts)
    .set({ status: 'RESOLVED' })
    .where(and(eq(conflicts.id, id)))
    .run();
}
