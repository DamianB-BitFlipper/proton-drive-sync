import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, test } from 'bun:test';
import { mergeThreeWay } from './merge.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createFixture(extension: string, base: string, local: string, remote: string) {
  const directory = await mkdtemp(join(tmpdir(), 'proton-drive-merge-test-'));
  temporaryDirectories.push(directory);
  const paths = {
    basePath: join(directory, `base${extension}`),
    localPath: join(directory, `local${extension}`),
    remotePath: join(directory, `remote${extension}`),
    outputPath: join(directory, `merged${extension}`),
  };
  await Bun.write(paths.basePath, base);
  await Bun.write(paths.localPath, local);
  await Bun.write(paths.remotePath, remote);
  return paths;
}

async function createOdtFixture(base: string, local: string, remote: string) {
  const fixture = await createFixture('.odt', '', '', '');
  const sourceFiles = [
    ['base', base],
    ['local', local],
    ['remote', remote],
  ] as const;

  for (const [name, content] of sourceFiles) {
    const textPath = join(dirname(fixture.basePath), `${name}.txt`);
    await Bun.write(textPath, content);
    const process = Bun.spawn([
      Bun.which('libreoffice') ?? 'libreoffice',
      '--headless',
      '--convert-to',
      'odt',
      '--outdir',
      dirname(fixture.basePath),
      textPath,
    ]);
    expect(await process.exited).toBe(0);
    await rm(textPath);
  }
  return fixture;
}

async function createOdtTableFixture() {
  const fixture = await createFixture('.odt', '', '', '');
  const directory = dirname(fixture.basePath);
  const html = `<!doctype html><html><body><table><tr><td>base</td></tr></table></body></html>`;
  for (const name of ['base', 'local', 'remote']) {
    const htmlPath = join(directory, `${name}.html`);
    await Bun.write(htmlPath, html.replace('base', name));
    const process = Bun.spawn([
      Bun.which('libreoffice') ?? 'libreoffice',
      '--headless',
      '--convert-to',
      'odt',
      '--outdir',
      directory,
      htmlPath,
    ]);
    expect(await process.exited).toBe(0);
    await rm(htmlPath);
  }
  return fixture;
}

describe('mergeThreeWay', () => {
  test('merges non-overlapping text changes', async () => {
    const paths = await createFixture(
      '.txt',
      'one\ntwo\nthree\n',
      'ONE\ntwo\nthree\n',
      'one\ntwo\nTHREE\n'
    );

    const result = await mergeThreeWay(paths);

    expect(result.status).toBe('merged');
    expect(await readFile(paths.outputPath, 'utf8')).toBe('ONE\ntwo\nTHREE\n');
  });

  test('merges non-overlapping ODT content through headless LibreOffice', async () => {
    if (!Bun.which('libreoffice')) return;
    const paths = await createOdtFixture(
      'heading\none\ntwo\nclosing\n',
      'heading\nONE\ntwo\nclosing\n',
      'heading\none\ntwo\nCLOSING\n'
    );

    const result = await mergeThreeWay(paths);

    expect(result.status).toBe('merged');
    expect((await readFile(paths.outputPath)).length).toBeGreaterThan(0);
  });

  test('returns conflict for overlapping ODT content changes', async () => {
    if (!Bun.which('libreoffice')) return;
    const paths = await createOdtFixture(
      'heading\none\nclosing\n',
      'heading\nLOCAL\nclosing\n',
      'heading\nREMOTE\nclosing\n'
    );

    const result = await mergeThreeWay(paths);

    expect(result.status).toBe('conflict');
    expect(result.outputPath).toBeUndefined();
  });

  test('does not flatten ODT tables during merge', async () => {
    if (!Bun.which('libreoffice') || !Bun.which('unzip')) return;
    const paths = await createOdtTableFixture();

    const result = await mergeThreeWay(paths);

    expect(result.status).toBe('unsupported');
    expect(result.details).toContain('tables');
  });

  test('returns conflict for unsupported binary files', async () => {
    const paths = await createFixture('.zip', 'base', 'local', 'remote');

    const result = await mergeThreeWay(paths);

    expect(result.status).toBe('conflict');
  });
});
