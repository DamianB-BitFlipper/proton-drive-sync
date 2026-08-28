import { dirname, extname, join } from 'path';
import { mkdir, mkdtemp, rm } from 'fs/promises';

export type MergeStatus = 'merged' | 'conflict' | 'unsupported' | 'failed';

export interface MergeInput {
  basePath: string;
  localPath: string;
  remotePath: string;
  outputPath: string;
}

export interface MergeResult {
  status: MergeStatus;
  outputPath?: string;
  details?: string;
}

export interface MergeDriver {
  canHandle(input: MergeInput): boolean;
  merge(input: MergeInput): Promise<MergeResult>;
}

const UNO_SCRIPT = String.raw`
import json, sys, time, uno
from com.sun.star.beans import PropertyValue

def prop(name, value):
  item = PropertyValue()
  item.Name = name
  item.Value = value
  return item

local_context = uno.getComponentContext()
resolver = local_context.ServiceManager.createInstanceWithContext(
  'com.sun.star.bridge.UnoUrlResolver', local_context)
context = None
for _ in range(100):
  try:
    context = resolver.resolve(
      'uno:socket,host=127.0.0.1,port=' + sys.argv[1] + ';urp;StarOffice.ComponentContext')
    break
  except Exception:
    time.sleep(0.05)
if context is None:
  raise RuntimeError('Unable to connect to LibreOffice UNO listener')

desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
mode = sys.argv[2]
if mode == 'extract':
  source = uno.systemPathToFileUrl(sys.argv[3])
  document = desktop.loadComponentFromURL(source, '_blank', 0, (prop('Hidden', True), prop('ReadOnly', True)))
  if document is None:
    raise RuntimeError('LibreOffice UNO could not load document')
  try:
    print(json.dumps({'text': document.Text.getString(), 'tables': document.getTextTables().getCount()}))
  finally:
    document.close(True)
elif mode == 'create':
  document = desktop.loadComponentFromURL('private:factory/swriter', '_blank', 0, (prop('Hidden', True),))
  if document is None:
    raise RuntimeError('LibreOffice UNO could not create document')
  try:
    output = uno.systemPathToFileUrl(sys.argv[4])
    document.Text.insertString(document.Text.End, sys.stdin.read(), False)
    document.storeAsURL(output, (prop('FilterName', 'writer8'), prop('Overwrite', True)))
    print(json.dumps({'ok': True}))
  finally:
    document.close(True)
`;

function isTextPath(path: string): boolean {
  return ['.txt', '.md', '.csv', '.json', '.xml', '.html', '.css'].includes(
    extname(path).toLowerCase()
  );
}

export class TextMergeDriver implements MergeDriver {
  canHandle(input: MergeInput): boolean {
    return isTextPath(input.localPath);
  }

  async merge(input: MergeInput): Promise<MergeResult> {
    const process = Bun.spawn(
      [
        'git',
        'merge-file',
        '--stdout',
        '--diff3',
        input.localPath,
        input.basePath,
        input.remotePath,
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const [output, errorOutput, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);

    if (exitCode === 0) {
      await Bun.write(input.outputPath, output);
      return { status: 'merged', outputPath: input.outputPath };
    }
    if (exitCode === 1) {
      return { status: 'conflict', details: 'Text merge produced unresolved conflict markers.' };
    }
    return { status: 'failed', details: errorOutput || `git merge-file exited with ${exitCode}` };
  }
}

export class LibreOfficeMergeDriver implements MergeDriver {
  canHandle(input: MergeInput): boolean {
    return extname(input.localPath).toLowerCase() === '.odt';
  }

  async merge(input: MergeInput): Promise<MergeResult> {
    const libreOffice = Bun.which('libreoffice') ?? Bun.which('soffice');
    if (!libreOffice) {
      return { status: 'unsupported', details: 'LibreOffice is not installed.' };
    }

    const temporaryDirectory = await mkdtemp(join(dirname(input.outputPath), '.odt-merge-'));
    const textDirectory = join(temporaryDirectory, 'text');
    const port = String(40000 + Math.floor(Math.random() * 2000));
    const profileDirectory = join(temporaryDirectory, 'profile');
    const office = Bun.spawn([
      libreOffice,
      '--headless',
      '--norestore',
      '--nofirststartwizard',
      `-env:UserInstallation=file://${profileDirectory}`,
      `--accept=socket,host=127.0.0.1,port=${port};urp;StarOffice.ComponentContext`,
    ]);

    try {
      await mkdir(textDirectory, { recursive: true });
      const extracted = await Promise.all(
        [input.basePath, input.localPath, input.remotePath].map((path) =>
          runUnoCommand(port, 'extract', path)
        )
      );
      if (extracted.some((result) => result.tables > 0)) {
        return {
          status: 'unsupported',
          details: 'ODT tables require a structure-preserving merge driver.',
        };
      }

      const textInput = {
        basePath: join(textDirectory, 'base.txt'),
        localPath: join(textDirectory, 'local.txt'),
        remotePath: join(textDirectory, 'remote.txt'),
        outputPath: join(temporaryDirectory, 'merged.txt'),
      };
      for (const [path, result] of [
        [textInput.basePath, extracted[0]],
        [textInput.localPath, extracted[1]],
        [textInput.remotePath, extracted[2]],
      ] as const) {
        await Bun.write(path, result.text.replace(/^\uFEFF/, ''));
      }
      const textResult = await new TextMergeDriver().merge(textInput);
      if (textResult.status !== 'merged') {
        return {
          ...textResult,
          details: `LibreOffice text merge: ${textResult.details ?? textResult.status}`,
        };
      }

      await runUnoCommand(port, 'create', textInput.outputPath, input.outputPath);
      return { status: 'merged', outputPath: input.outputPath };
    } catch (error) {
      return {
        status: 'failed',
        details: `LibreOffice merge failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      office.kill();
      await office.exited;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

async function runUnoCommand(
  port: string,
  mode: 'extract' | 'create',
  sourcePath: string,
  outputPath?: string
): Promise<{ text: string; tables: number }> {
  const args = ['python3', '-c', UNO_SCRIPT, port, mode, sourcePath];
  if (outputPath) args.push(outputPath);
  const process = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  if (mode === 'create') {
    process.stdin.write(await Bun.file(sourcePath).text());
  }
  process.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || `UNO command failed with ${exitCode}`);
  return JSON.parse(stdout.trim()) as { text: string; tables: number };
}

export class BinaryMergeDriver implements MergeDriver {
  canHandle(_input: MergeInput): boolean {
    return true;
  }

  async merge(_input: MergeInput): Promise<MergeResult> {
    return { status: 'conflict', details: 'No safe merge driver is available for this file.' };
  }
}

const mergeDrivers: MergeDriver[] = [
  new TextMergeDriver(),
  new LibreOfficeMergeDriver(),
  new BinaryMergeDriver(),
];

export async function mergeThreeWay(input: MergeInput): Promise<MergeResult> {
  const driver = mergeDrivers.find((candidate) => candidate.canHandle(input));
  if (!driver) return { status: 'conflict', details: 'No merge driver is available.' };
  return driver.merge(input);
}
