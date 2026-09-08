import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { remoteEventState } from '../db/schema.js';

export function getRemoteEventState(syncDirPath: string): {
  treeEventScopeId: string;
  lastEventId: string | null;
} | null {
  const state = db
    .select()
    .from(remoteEventState)
    .where(eq(remoteEventState.syncDirPath, syncDirPath))
    .get();
  return state
    ? { treeEventScopeId: state.treeEventScopeId, lastEventId: state.lastEventId }
    : null;
}

export function storeRemoteEventState(
  syncDirPath: string,
  treeEventScopeId: string,
  lastEventId: string,
  tx: Tx
): void {
  tx.insert(remoteEventState)
    .values({ syncDirPath, treeEventScopeId, lastEventId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: remoteEventState.syncDirPath,
      set: { treeEventScopeId, lastEventId, updatedAt: new Date() },
    })
    .run();
}
