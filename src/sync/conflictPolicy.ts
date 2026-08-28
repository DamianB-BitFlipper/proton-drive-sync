export interface ConflictComparison {
  localSha1: string | null;
  baselineLocalSha1: string | null;
  baselineRemoteRevisionUid: string | null;
  currentRemoteRevisionUid: string | null;
  baselineRemoteSha1: string | null;
  currentRemoteSha1: string | null;
}

export interface ConflictDecision {
  localChanged: boolean;
  remoteChanged: boolean;
  conflict: boolean;
}

export function compareConflictState(comparison: ConflictComparison): ConflictDecision {
  const localChanged =
    comparison.localSha1 !== null &&
    (comparison.baselineLocalSha1 === null ||
      comparison.localSha1.toLowerCase() !== comparison.baselineLocalSha1.toLowerCase());
  const hasRemoteBaseline =
    comparison.baselineRemoteRevisionUid !== null || comparison.baselineRemoteSha1 !== null;
  const remoteChanged =
    hasRemoteBaseline &&
    ((comparison.currentRemoteRevisionUid !== null &&
      comparison.currentRemoteRevisionUid !== comparison.baselineRemoteRevisionUid) ||
      (comparison.currentRemoteSha1 !== null &&
        comparison.currentRemoteSha1.toLowerCase() !==
          (comparison.baselineRemoteSha1 ?? '').toLowerCase()));

  return { localChanged, remoteChanged, conflict: localChanged && remoteChanged };
}
