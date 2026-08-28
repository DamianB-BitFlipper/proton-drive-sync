import { mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { db } from '../db/index.js';
import { SyncEventType } from '../db/schema.js';
import { logger } from '../logger.js';
import type { Config, SyncDir } from '../config.js';
import type { ProtonDriveClient, RemoteEvent } from '../proton/types.js';
import { findFolderByName } from '../proton/utils.js';
import { setNodeMapping, getNodeMappingByUid, deleteNodeMapping } from './nodes.js';
import { enqueueJob } from './queue.js';
import { getRemoteEventState, storeRemoteEventState } from './remoteState.js';
import { isPathExcluded } from './exclusions.js';
import { deleteChangeToken, deleteChangeTokensUnderPath } from './fileState.js';
import { computeFileSha1, getFileState } from './fileState.js';
import { getBaseSnapshot } from './baseSnapshots.js';
import { compareConflictState } from './conflictPolicy.js';
import { isTwoWaySyncEnabled } from './syncDirection.js';

interface RemoteWatcherHandle {
  stop: () => void;
}

function getRemoteParts(remoteRoot: string): string[] {
  return remoteRoot.split('/').filter(Boolean);
}

async function resolveRemoteRoot(client: ProtonDriveClient, syncDir: SyncDir): Promise<string> {
  const root = await client.getMyFilesRootFolder();
  let currentUid = root.value?.uid;
  if (!currentUid)
    throw new Error(`Unable to resolve Proton Drive root for ${syncDir.remote_root}`);

  for (const part of getRemoteParts(syncDir.remote_root)) {
    const nextUid = await findFolderByName(client, currentUid, part);
    if (!nextUid) throw new Error(`Remote folder not found: ${syncDir.remote_root}`);
    currentUid = nextUid;
  }
  return currentUid;
}

async function seedRemoteRoot(
  client: ProtonDriveClient,
  syncDir: SyncDir
): Promise<{ nodeUid: string; scopeId: string }> {
  const nodeUid = await resolveRemoteRoot(client, syncDir);
  const node = await client.getNode(nodeUid);
  if (!node.ok || !node.value?.treeEventScopeId) {
    throw new Error(`Unable to resolve event scope for ${syncDir.remote_root}`);
  }
  db.transaction((tx) => {
    setNodeMapping(syncDir.source_path, syncDir.remote_root, nodeUid, nodeUid, true, false, tx);
  });
  await mkdir(syncDir.source_path, { recursive: true });
  return { nodeUid, scopeId: node.value.treeEventScopeId };
}

async function bootstrapRemoteTree(
  client: ProtonDriveClient,
  remoteUid: string,
  localPath: string,
  remotePath: string
): Promise<void> {
  for await (const childResult of client.iterateFolderChildren(remoteUid)) {
    if (!childResult.ok || !childResult.value) continue;
    const child = childResult.value;
    const childLocalPath = join(localPath, child.name);
    const childRemotePath = `${remotePath}/${child.name}`;

    db.transaction((tx) => {
      setNodeMapping(
        childLocalPath,
        childRemotePath,
        child.uid,
        child.parentUid ?? remoteUid,
        child.type === 'folder',
        false,
        tx
      );
      if (child.type === 'file') {
        const revision = child.activeRevision;
        enqueueJob(
          {
            eventType: SyncEventType.DOWNLOAD_FILE,
            localPath: childLocalPath,
            remotePath: childRemotePath,
            changeToken: null,
          },
          false,
          tx
        );
        setNodeMapping(
          childLocalPath,
          childRemotePath,
          child.uid,
          child.parentUid ?? remoteUid,
          false,
          false,
          tx,
          {
            revisionUid: revision?.uid,
            sha1: revision?.claimedDigests?.sha1,
            modifiedAt: revision?.claimedModificationTime,
          }
        );
      }
    });

    if (child.type === 'folder') {
      await mkdir(childLocalPath, { recursive: true });
      await bootstrapRemoteTree(client, child.uid, childLocalPath, childRemotePath);
    }
  }
}

async function handleRemoteEvent(
  client: ProtonDriveClient,
  syncDir: SyncDir,
  event: RemoteEvent
): Promise<void> {
  if (
    event.type === 'fast_forward' ||
    event.type === 'tree_refresh' ||
    event.type === 'tree_remove'
  ) {
    logger.info(`Remote tree event requires reconciliation: ${event.type}`);
    return;
  }

  if (!('nodeUid' in event)) return;

  if (event.type === 'node_deleted') {
    const mapping = getNodeMappingByUid(event.nodeUid);
    if (!mapping) return;
    if (!mapping.isDirectory) {
      const currentSha1 = await computeFileSha1(mapping.localPath);
      const state = db.transaction((tx) => getFileState(mapping.localPath, tx));
      if (currentSha1 && (!state || currentSha1 !== state.contentSha1)) return;
    }
    await rm(mapping.localPath, { recursive: mapping.isDirectory, force: true });
    db.transaction((tx) => {
      deleteChangeToken(mapping.localPath, false, tx);
      deleteNodeMapping(mapping.localPath, mapping.remotePath, false, tx);
      if (mapping.isDirectory) deleteChangeTokensUnderPath(mapping.localPath, tx);
    });
    return;
  }

  const nodeResult = await client.getNode(event.nodeUid);
  if (!nodeResult.ok || !nodeResult.value) {
    throw new Error(`Unable to resolve remote node ${event.nodeUid}`);
  }

  const node = nodeResult.value;
  const existingMapping = getNodeMappingByUid(node.uid);
  const parentMapping = node.parentUid ? getNodeMappingByUid(node.parentUid) : null;
  if (!existingMapping && !parentMapping) {
    logger.debug(`Skipping remote node outside mapped sync tree: ${node.uid}`);
    return;
  }

  const baseMapping = existingMapping ?? parentMapping;
  if (!baseMapping) return;
  const localPath = existingMapping
    ? existingMapping.localPath
    : join(baseMapping.localPath, node.name);
  const remotePath = existingMapping
    ? existingMapping.remotePath
    : `${baseMapping.remotePath}/${node.name}`;

  if (isPathExcluded(localPath, syncDir.source_path, [])) return;

  const remoteRevisionUid = node.activeRevision?.uid;
  const remoteSha1 = node.activeRevision?.claimedDigests?.sha1;
  const remoteModifiedAt = node.activeRevision?.claimedModificationTime;
  let remoteChanged = !existingMapping;

  if (node.type === 'file') {
    const localSha1 = await computeFileSha1(localPath);
    const localState = db.transaction((tx) => getFileState(localPath, tx));
    const decision = compareConflictState({
      localSha1,
      baselineLocalSha1: localState?.contentSha1 ?? null,
      baselineRemoteRevisionUid: existingMapping?.remoteRevisionUid ?? null,
      currentRemoteRevisionUid: remoteRevisionUid ?? null,
      baselineRemoteSha1: existingMapping?.remoteSha1 ?? null,
      currentRemoteSha1: remoteSha1 ?? null,
    });
    remoteChanged = decision.remoteChanged || !existingMapping;

    remoteChanged = decision.remoteChanged || !existingMapping;
    const hasBaseSnapshot = Boolean(getBaseSnapshot(localPath));
    if (decision.conflict && hasBaseSnapshot) remoteChanged = true;
  }

  db.transaction((tx) => {
    setNodeMapping(
      localPath,
      remotePath,
      node.uid,
      node.parentUid ?? node.uid,
      node.type === 'folder',
      false,
      tx,
      { revisionUid: remoteRevisionUid, sha1: remoteSha1, modifiedAt: remoteModifiedAt }
    );
    if (node.type === 'file' && remoteChanged) {
      enqueueJob(
        {
          eventType:
            existingMapping && getBaseSnapshot(localPath) && node.type === 'file'
              ? SyncEventType.MERGE_FILE
              : SyncEventType.DOWNLOAD_FILE,
          localPath,
          remotePath,
          changeToken: null,
        },
        false,
        tx
      );
    }
  });
}

export async function startRemoteWatcher(
  client: ProtonDriveClient,
  config: Config
): Promise<RemoteWatcherHandle> {
  let running = true;
  const controllers: AbortController[] = [];

  for (const syncDir of config.sync_dirs.filter(isTwoWaySyncEnabled)) {
    const controller = new AbortController();
    controllers.push(controller);

    void (async () => {
      while (running && !controller.signal.aborted) {
        try {
          const root = await seedRemoteRoot(client, syncDir);
          const state = getRemoteEventState(syncDir.source_path);
          const scopeId = state?.treeEventScopeId ?? root.scopeId;

          if (!state) {
            await bootstrapRemoteTree(
              client,
              root.nodeUid,
              syncDir.source_path,
              syncDir.remote_root
            );
          }

          let lastEventId = state?.lastEventId ?? undefined;
          for await (const event of client.iterateEvents(scopeId, lastEventId, controller.signal)) {
            if (!running || controller.signal.aborted) break;
            await handleRemoteEvent(client, syncDir, event);
            lastEventId = event.eventId;
            db.transaction((tx) =>
              storeRemoteEventState(syncDir.source_path, scopeId, event.eventId, tx)
            );
          }
        } catch (error) {
          logger.warn(`Remote event watcher failed for ${syncDir.source_path}: ${error}`);
          if (running && !controller.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
        }
      }
    })();
  }

  return {
    stop: () => {
      running = false;
      for (const controller of controllers) controller.abort();
    },
  };
}
