import { describe, expect, test } from 'bun:test';
import { compareConflictState } from './conflictPolicy.js';

const baseline = {
  baselineLocalSha1: 'base',
  baselineRemoteRevisionUid: 'revision-1',
  baselineRemoteSha1: 'remote-base',
};

describe('compareConflictState', () => {
  test('does not conflict when only the local file changed', () => {
    expect(
      compareConflictState({
        ...baseline,
        localSha1: 'local-new',
        currentRemoteRevisionUid: 'revision-1',
        currentRemoteSha1: 'remote-base',
      })
    ).toEqual({ localChanged: true, remoteChanged: false, conflict: false });
  });

  test('does not conflict when only the remote file changed', () => {
    expect(
      compareConflictState({
        ...baseline,
        localSha1: 'base',
        currentRemoteRevisionUid: 'revision-2',
        currentRemoteSha1: 'remote-new',
      })
    ).toEqual({ localChanged: false, remoteChanged: true, conflict: false });
  });

  test('detects simultaneous changes', () => {
    expect(
      compareConflictState({
        ...baseline,
        localSha1: 'local-new',
        currentRemoteRevisionUid: 'revision-2',
        currentRemoteSha1: 'remote-new',
      })
    ).toEqual({ localChanged: true, remoteChanged: true, conflict: true });
  });

  test('treats case-only digest differences as unchanged', () => {
    expect(
      compareConflictState({
        ...baseline,
        localSha1: 'BASE',
        currentRemoteRevisionUid: 'revision-1',
        currentRemoteSha1: 'REMOTE-BASE',
      })
    ).toEqual({ localChanged: false, remoteChanged: false, conflict: false });
  });

  test('does not invent a conflict without a remote baseline', () => {
    expect(
      compareConflictState({
        localSha1: 'local-new',
        baselineLocalSha1: 'base',
        baselineRemoteRevisionUid: null,
        currentRemoteRevisionUid: 'revision-1',
        baselineRemoteSha1: null,
        currentRemoteSha1: 'remote-new',
      })
    ).toEqual({ localChanged: true, remoteChanged: false, conflict: false });
  });
});
