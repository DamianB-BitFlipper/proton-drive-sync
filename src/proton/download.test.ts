import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { downloadNode } from './download.js';
import { FakeProtonClient } from '../test/fakes/fakeProtonClient.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('downloadNode', () => {
  test('downloads through the Proton client and writes decrypted content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'proton-drive-sync-test-'));
    temporaryDirectories.push(directory);
    const destination = join(directory, 'nested', 'file.txt');
    const client = new FakeProtonClient(new TextEncoder().encode('remote content'));

    await downloadNode(client, 'node-123', destination);

    expect(await readFile(destination, 'utf8')).toBe('remote content');
    expect(client.requestedNodeUids).toEqual(['node-123']);
  });
});
