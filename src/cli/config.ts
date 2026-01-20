/**
 * Config Command - Manage configuration via subcommands
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { select, confirm, input } from '@inquirer/prompts';

import {
  CONFIG_FILE,
  CONFIG_CHECK_SIGNAL,
  ensureConfigDir,
  getConfig,
  defaultConfig,
} from '../config.js';
import type { Config, ExcludePattern, SyncDir, RemoteDeleteBehavior, WatcherConfig } from '../config.js';
import { sendSignal } from '../signals.js';
import { chownToEffectiveUser } from '../paths.js';
import { validateGlob, clearRegexCache } from '../sync/exclusions.js';

// ============================================================================
// Base Config Command
// ============================================================================

/**
 * Base config command - interactive menu to configure settings
 */
export async function configCommand(): Promise<void> {
  while (true) {
    console.log('');
    const action = await select({
      message: 'What would you like to configure?',
      choices: [
        { name: 'View current config', value: 'get' },
        { name: 'Remote delete behavior', value: 'remote-delete' },
        { name: 'Dashboard host', value: 'dashboard-host' },
        { name: 'Dashboard port', value: 'dashboard-port' },
        { name: 'Sync concurrency', value: 'concurrency' },
        { name: 'Sync directories', value: 'sync-dir' },
        { name: 'Exclusion patterns', value: 'exclude' },
        { name: 'Watcher settings', value: 'watcher' },
        { name: 'Done', value: 'done' },
      ],
    });

    if (action === 'done') {
      break;
    }

    switch (action) {
      case 'get':
        getCommand(undefined, {});
        break;
      case 'remote-delete':
        await remoteDeleteBehaviorCommand();
        break;
      case 'dashboard-host':
        await dashboardHostCommand();
        break;
      case 'dashboard-port':
        await dashboardPortCommand();
        break;
      case 'concurrency':
        await concurrencyCommand();
        break;
      case 'sync-dir':
        await syncDirCommand({});
        break;
      case 'exclude':
        await excludeCommand({});
        break;
      case 'watcher':
        await watcherCommand();
        break;
    }
  }
}

// ============================================================================
// Config File Helpers
// ============================================================================

/**
 * Load config file as raw JSON to preserve unknown fields
 */
export function loadConfigRaw(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  const content = readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save config file and notify running service
 */
export function saveConfigRaw(config: Record<string, unknown>): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  chownToEffectiveUser(CONFIG_FILE);
  // Notify running service to reload config
  sendSignal(CONFIG_CHECK_SIGNAL);
}

// ============================================================================
// Get Subcommand
// ============================================================================

interface GetOptions {
  json?: boolean;
}

/**
 * Get config values
 */
export function getCommand(key: string | undefined, options: GetOptions): void {
  const config = getConfig();

  if (options.json) {
    if (key) {
      const value = config[key as keyof Config];
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
    return;
  }

  // Human-readable output
  if (key) {
    const value = config[key as keyof Config];
    if (value === undefined) {
      console.log(`${key}: (not set)`);
    } else if (typeof value === 'object') {
      console.log(`${key}:`);
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(`${key}: ${value}`);
    }
  } else {
    // Show all config
    console.log('Current configuration:\n');
    console.log(`  dashboard_host: ${config.dashboard_host}`);
    console.log(`  dashboard_port: ${config.dashboard_port}`);
    console.log(`  sync_concurrency: ${config.sync_concurrency}`);
    console.log(`  remote_delete_behavior: ${config.remote_delete_behavior}`);

    if (config.sync_dirs && config.sync_dirs.length > 0) {
      console.log('\n  sync_dirs:');
      for (const dir of config.sync_dirs) {
        console.log(`    - ${dir.source_path} -> ${dir.remote_root}`);
      }
    } else {
      console.log('\n  sync_dirs: (none configured)');
    }

    if (config.exclude_patterns && config.exclude_patterns.length > 0) {
      console.log('\n  exclude_patterns:');
      for (const entry of config.exclude_patterns) {
        const pathLabel = entry.path === '/' ? '/ (global)' : entry.path;
        console.log(`    ${pathLabel}: ${entry.globs.join(', ')}`);
      }
    } else {
      console.log('\n  exclude_patterns: (none configured)');
    }

    console.log('\n  watcher:');
    console.log(`    use_polling: ${config.watcher.use_polling}`);
    console.log(`    polling_interval: ${config.watcher.polling_interval}ms`);

    console.log(`\nConfig file: ${CONFIG_FILE}`);
  }
}

// ============================================================================
// Remote Delete Behavior Subcommand
// ============================================================================

/**
 * Set remote delete behavior (interactive if no value provided)
 */
export async function remoteDeleteBehaviorCommand(value?: string): Promise<void> {
  if (value !== undefined) {
    // Non-interactive mode
    if (value !== 'trash' && value !== 'permanent') {
      console.error('Invalid value. Must be "trash" or "permanent".');
      process.exit(1);
    }
    const config = loadConfigRaw();
    config.remote_delete_behavior = value as RemoteDeleteBehavior;
    saveConfigRaw(config);
    console.log(`Set remote_delete_behavior = ${value}`);
    return;
  }

  // Interactive mode
  const config = loadConfigRaw();
  const current =
    (config.remote_delete_behavior as RemoteDeleteBehavior) ?? defaultConfig.remote_delete_behavior;

  const behavior = await select({
    message: 'When you delete a local file, what should happen to the copy on Proton Drive?',
    choices: [
      {
        name: 'Move to trash (recoverable)',
        value: 'trash',
        description:
          'Note: You will need to periodically empty the trash manually to free up space.',
      },
      {
        name: 'Delete permanently (unrecoverable)',
        value: 'permanent',
        description: 'WARNING: Files will be permanently deleted and cannot be recovered.',
      },
    ],
    default: current,
  });

  config.remote_delete_behavior = behavior;
  saveConfigRaw(config);

  if (behavior === 'trash') {
    console.log('Remote delete behavior set to: move to trash');
    console.log(
      'Note: You will need to periodically empty the Proton Drive trash to free up space.'
    );
  } else {
    console.log('Remote delete behavior set to: permanent deletion');
    console.log('Warning: Deleted files cannot be recovered.');
  }
}

// ============================================================================
// Dashboard Host Subcommand
// ============================================================================

/**
 * Set dashboard host (interactive if no value provided)
 */
export async function dashboardHostCommand(value?: string): Promise<void> {
  if (value !== undefined) {
    // Non-interactive mode
    const config = loadConfigRaw();
    config.dashboard_host = value;
    saveConfigRaw(config);
    console.log(`Set dashboard_host = ${value}`);
    return;
  }

  // Interactive mode
  console.log('');
  console.log('  The dashboard is available at localhost:4242 by default.');
  console.log('');
  console.log('  For headless/server installs, you can enable remote access by binding');
  console.log('  the web interface to all network interfaces (0.0.0.0:4242).');
  console.log('');
  console.log('  \x1b[33mWARNING: This exposes the dashboard to your network.\x1b[0m');
  console.log('  The dashboard allows service control and configuration changes.');
  console.log('  Only enable this on trusted networks or behind a firewall.');
  console.log('');

  const config = loadConfigRaw();
  const currentlyRemote = config.dashboard_host === '0.0.0.0';

  const enableRemote = await confirm({
    message: 'Enable remote dashboard access?',
    default: currentlyRemote,
  });

  const newHost = enableRemote ? '0.0.0.0' : defaultConfig.dashboard_host;
  config.dashboard_host = newHost;
  saveConfigRaw(config);

  if (enableRemote) {
    console.log('Remote dashboard access enabled (0.0.0.0:4242)');
  } else {
    console.log('Dashboard will only be accessible locally (localhost:4242)');
  }
}

// ============================================================================
// Dashboard Port Subcommand
// ============================================================================

/**
 * Set dashboard port (interactive if no value provided)
 */
export async function dashboardPortCommand(value?: string): Promise<void> {
  if (value !== undefined) {
    // Non-interactive mode
    const port = parseInt(value, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number. Must be between 1 and 65535.');
      process.exit(1);
    }
    const config = loadConfigRaw();
    config.dashboard_port = port;
    saveConfigRaw(config);
    console.log(`Set dashboard_port = ${port}`);
    return;
  }

  // Interactive mode
  const config = loadConfigRaw();
  const currentPort = (config.dashboard_port as number) ?? defaultConfig.dashboard_port;

  const portStr = await input({
    message: 'Dashboard port:',
    default: String(currentPort),
    validate: (val) => {
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1 || num > 65535) {
        return 'Must be a valid port number (1-65535)';
      }
      return true;
    },
  });

  const port = parseInt(portStr, 10);
  config.dashboard_port = port;
  saveConfigRaw(config);
  console.log(`Set dashboard_port = ${port}`);
}

// ============================================================================
// Concurrency Subcommand
// ============================================================================

/**
 * Set sync concurrency (interactive if no value provided)
 */
export async function concurrencyCommand(value?: string): Promise<void> {
  if (value !== undefined) {
    // Non-interactive mode
    const num = parseInt(value, 10);
    if (isNaN(num) || num < 1) {
      console.error('Invalid concurrency value. Must be a positive integer.');
      process.exit(1);
    }
    const config = loadConfigRaw();
    config.sync_concurrency = num;
    saveConfigRaw(config);
    console.log(`Set sync_concurrency = ${num}`);
    return;
  }

  // Interactive mode
  const config = loadConfigRaw();
  const current = (config.sync_concurrency as number) ?? defaultConfig.sync_concurrency;

  const numStr = await input({
    message: 'Sync concurrency (parallel uploads):',
    default: String(current),
    validate: (val) => {
      const num = parseInt(val, 10);
      if (isNaN(num) || num < 1) {
        return 'Must be a positive integer';
      }
      return true;
    },
  });

  const num = parseInt(numStr, 10);
  config.sync_concurrency = num;
  saveConfigRaw(config);
  console.log(`Set sync_concurrency = ${num}`);
}

// ============================================================================
// Sync Dir Subcommand
// ============================================================================

interface SyncDirOptions {
  list?: boolean;
  add?: string;
  remote?: string;
  remove?: string;
}

/**
 * Manage sync directories
 */
export async function syncDirCommand(options: SyncDirOptions): Promise<void> {
  // Non-interactive: --list
  if (options.list) {
    listSyncDirs();
    return;
  }

  // Non-interactive: --add
  if (options.add) {
    addSyncDir(options.add, options.remote ?? '/');
    return;
  }

  // Non-interactive: --remove
  if (options.remove) {
    removeSyncDir(options.remove);
    return;
  }

  // Interactive mode
  await syncDirInteractive();
}

function listSyncDirs(): void {
  const config = getConfig();

  if (!config.sync_dirs || config.sync_dirs.length === 0) {
    console.log('No sync directories configured.');
    console.log('\nAdd one with: proton-drive-sync config sync-dir --add <path>');
    return;
  }

  console.log('Sync directories:\n');
  for (const dir of config.sync_dirs) {
    console.log(`  ${dir.source_path} -> ${dir.remote_root}`);
  }
}

function addSyncDir(sourcePath: string, remoteRoot: string): void {
  // Validate source path exists
  if (!existsSync(sourcePath)) {
    console.error(`Directory does not exist: ${sourcePath}`);
    process.exit(1);
  }

  // Ensure remote root starts with /
  if (!remoteRoot.startsWith('/')) {
    remoteRoot = '/' + remoteRoot;
  }

  // Remove trailing slash from source path to ensure consistent path matching
  if (sourcePath.endsWith('/') && sourcePath.length > 1) {
    sourcePath = sourcePath.slice(0, -1);
  }

  const config = loadConfigRaw();
  const syncDirs = (config.sync_dirs as SyncDir[]) ?? [];

  // Check for duplicates
  if (syncDirs.some((d) => d.source_path === sourcePath)) {
    console.log(`Sync directory already exists: ${sourcePath}`);
    return;
  }

  syncDirs.push({ source_path: sourcePath, remote_root: remoteRoot });
  config.sync_dirs = syncDirs;
  saveConfigRaw(config);
  console.log(`Added sync directory: ${sourcePath} -> ${remoteRoot}`);
}

function removeSyncDir(sourcePath: string): void {
  const config = loadConfigRaw();
  const syncDirs = (config.sync_dirs as SyncDir[]) ?? [];

  const index = syncDirs.findIndex((d) => d.source_path === sourcePath);
  if (index === -1) {
    console.log(`Sync directory not found: ${sourcePath}`);
    return;
  }

  syncDirs.splice(index, 1);
  config.sync_dirs = syncDirs;
  saveConfigRaw(config);
  console.log(`Removed sync directory: ${sourcePath}`);
}

async function syncDirInteractive(): Promise<void> {
  while (true) {
    const config = loadConfigRaw();
    const syncDirs = (config.sync_dirs as SyncDir[]) ?? [];

    console.log('');
    if (syncDirs.length === 0) {
      console.log('No sync directories configured.');
    } else {
      console.log('Current sync directories:');
      for (const dir of syncDirs) {
        console.log(`  ${dir.source_path} -> ${dir.remote_root}`);
      }
    }
    console.log('');

    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Add new sync directory', value: 'add' },
        ...(syncDirs.length > 0 ? [{ name: 'Remove sync directory', value: 'remove' }] : []),
        { name: 'Done', value: 'done' },
      ],
    });

    if (action === 'done') {
      break;
    }

    if (action === 'add') {
      const sourcePath = await input({
        message: 'Local directory path:',
        validate: (val) => {
          if (!val.trim()) {
            return 'Path is required';
          }
          if (!existsSync(val)) {
            return 'Directory does not exist';
          }
          return true;
        },
      });

      const remoteRoot = await input({
        message: 'Remote root path:',
        default: '/',
      });

      addSyncDir(sourcePath, remoteRoot);
    }

    if (action === 'remove') {
      const choices = syncDirs.map((d) => ({
        name: `${d.source_path} -> ${d.remote_root}`,
        value: d.source_path,
      }));

      const toRemove = await select({
        message: 'Select directory to remove:',
        choices,
      });

      removeSyncDir(toRemove);
    }
  }
}

// ============================================================================
// Exclude Subcommand
// ============================================================================

interface ExcludeOptions {
  path?: string;
  add?: string[];
  remove?: string[];
  list?: boolean;
}

/**
 * Exclude subcommand handler - manage file exclusion patterns
 */
export async function excludeCommand(options: ExcludeOptions): Promise<void> {
  const targetPath = options.path ?? '/';

  // Handle --list
  if (options.list) {
    listExclusions(targetPath);
    return;
  }

  // Handle --add
  if (options.add && options.add.length > 0) {
    addExclusions(targetPath, options.add);
    return;
  }

  // Handle --remove
  if (options.remove && options.remove.length > 0) {
    removeExclusions(targetPath, options.remove);
    return;
  }

  // No action specified, enter interactive mode
  await excludeInteractive();
}

/**
 * Interactive mode for managing exclusion patterns
 */
async function excludeInteractive(): Promise<void> {
  while (true) {
    const config = loadConfigRaw();
    const patterns = getExcludePatternsFromRaw(config);

    console.log('');
    if (patterns.length === 0) {
      console.log('No exclusion patterns configured.');
    } else {
      console.log('Current exclusion patterns:');
      for (const entry of patterns) {
        const pathLabel = entry.path === '/' ? '/ (global - all sync dirs)' : entry.path;
        console.log(`  ${pathLabel}`);
        for (const glob of entry.globs) {
          console.log(`    - ${glob}`);
        }
      }
    }
    console.log('');

    // Build choices - only show remove if there are patterns
    const hasPatterns = patterns.some((p) => p.globs.length > 0);
    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Add exclusion pattern', value: 'add' },
        ...(hasPatterns ? [{ name: 'Remove exclusion pattern', value: 'remove' }] : []),
        { name: 'Done', value: 'done' },
      ],
    });

    if (action === 'done') {
      break;
    }

    if (action === 'add') {
      const path = await input({
        message: 'Path (/ for global, or specific path):',
        default: '/',
      });

      const pattern = await input({
        message: 'Glob pattern to exclude (e.g., node_modules, *.log):',
        validate: (val) => {
          if (!val.trim()) {
            return 'Pattern is required';
          }
          const result = validateGlob(val);
          return result.valid ? true : result.error!;
        },
      });

      addExclusions(path, [pattern]);
    }

    if (action === 'remove') {
      // Build a flat list of all patterns with their paths
      const choices: { name: string; value: { path: string; glob: string } }[] = [];
      for (const entry of patterns) {
        const pathLabel = entry.path === '/' ? '(global)' : entry.path;
        for (const glob of entry.globs) {
          choices.push({
            name: `${glob} ${pathLabel}`,
            value: { path: entry.path, glob },
          });
        }
      }

      const toRemove = await select({
        message: 'Select pattern to remove:',
        choices,
      });

      removeExclusions(toRemove.path, [toRemove.glob]);
    }
  }
}

/**
 * Get exclude_patterns array from config, ensuring it exists
 */
function getExcludePatternsFromRaw(config: Record<string, unknown>): ExcludePattern[] {
  if (!config.exclude_patterns || !Array.isArray(config.exclude_patterns)) {
    return [];
  }
  return config.exclude_patterns as ExcludePattern[];
}

/**
 * Find or create an entry for a specific path
 */
function findOrCreateEntry(patterns: ExcludePattern[], path: string): ExcludePattern {
  let entry = patterns.find((p) => p.path === path);
  if (!entry) {
    entry = { path, globs: [] };
    patterns.push(entry);
  }
  return entry;
}

/**
 * List exclusion patterns
 */
function listExclusions(targetPath: string): void {
  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);

  if (targetPath === '/') {
    // List all exclusions
    if (patterns.length === 0) {
      console.log('No exclusion patterns configured.');
      console.log('\nAdd patterns with: proton-drive-sync config exclude --add <pattern>');
      return;
    }

    console.log('Exclusion patterns:\n');
    for (const entry of patterns) {
      const pathLabel = entry.path === '/' ? '/ (global - all sync dirs)' : entry.path;
      console.log(`  ${pathLabel}`);
      for (const glob of entry.globs) {
        console.log(`    - ${glob}`);
      }
    }
  } else {
    // List exclusions for specific path
    const entry = patterns.find((p) => p.path === targetPath);
    if (!entry || entry.globs.length === 0) {
      console.log(`No exclusion patterns for path: ${targetPath}`);
      return;
    }

    console.log(`Exclusion patterns for ${targetPath}:\n`);
    for (const glob of entry.globs) {
      console.log(`  - ${glob}`);
    }
  }
}

/**
 * Add exclusion patterns
 */
function addExclusions(targetPath: string, globs: string[]): void {
  // Validate all patterns first
  for (const glob of globs) {
    const result = validateGlob(glob);
    if (!result.valid) {
      console.error(`Invalid pattern "${glob}": ${result.error}`);
      process.exit(1);
    }
  }

  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);
  const entry = findOrCreateEntry(patterns, targetPath);

  let addedCount = 0;
  for (const glob of globs) {
    // Skip duplicates silently
    if (!entry.globs.includes(glob)) {
      entry.globs.push(glob);
      addedCount++;
      console.log(`Added exclusion pattern: ${glob}`);
    }
  }

  if (addedCount === 0) {
    console.log('All patterns already exist.');
    return;
  }

  config.exclude_patterns = patterns;
  saveConfigRaw(config);
  clearRegexCache();

  const pathLabel = targetPath === '/' ? 'global' : targetPath;
  console.log(`\nSaved ${addedCount} pattern(s) to ${pathLabel} exclusions.`);
}

/**
 * Remove exclusion patterns
 */
function removeExclusions(targetPath: string, globs: string[]): void {
  const config = loadConfigRaw();
  const patterns = getExcludePatternsFromRaw(config);
  const entry = patterns.find((p) => p.path === targetPath);

  if (!entry) {
    console.log(`No exclusions found for path: ${targetPath}`);
    return;
  }

  let removedCount = 0;
  for (const glob of globs) {
    const index = entry.globs.indexOf(glob);
    if (index !== -1) {
      entry.globs.splice(index, 1);
      removedCount++;
      console.log(`Removed exclusion pattern: ${glob}`);
    }
  }

  if (removedCount === 0) {
    console.log('No matching patterns found to remove.');
    return;
  }

  // Remove entry if no globs left
  if (entry.globs.length === 0) {
    const entryIndex = patterns.indexOf(entry);
    patterns.splice(entryIndex, 1);
  }

  config.exclude_patterns = patterns.length > 0 ? patterns : undefined;
  saveConfigRaw(config);
  clearRegexCache();

  const pathLabel = targetPath === '/' ? 'global' : targetPath;
  console.log(`\nRemoved ${removedCount} pattern(s) from ${pathLabel} exclusions.`);
}

// ============================================================================
// Watcher Subcommand
// ============================================================================

/**
 * Configure watcher settings (use_polling and polling_interval)
 */
export async function watcherCommand(): Promise<void> {
  const config = loadConfigRaw();
  const watcher = (config.watcher as WatcherConfig) ?? { ...defaultConfig.watcher };

  console.log('');
  console.log('  File watcher settings control how changes are detected in your sync directories.');
  console.log('');
  console.log('  By default, native filesystem events are used (more efficient).');
  console.log('  Polling mode is more reliable for network drives (NFS, CIFS, SSHFS) or');
  console.log('  certain environments where native events may not work correctly.');
  console.log('');

  const usePolling = await confirm({
    message: 'Use polling mode instead of native filesystem events?',
    default: watcher.use_polling,
  });

  let pollingInterval = watcher.polling_interval;
  if (usePolling) {
    const intervalStr = await input({
      message: 'Polling interval (in milliseconds):',
      default: String(watcher.polling_interval),
      validate: (val) => {
        const num = parseInt(val, 10);
        if (isNaN(num) || num < 100) {
          return 'Must be a number >= 100ms';
        }
        return true;
      },
    });
    pollingInterval = parseInt(intervalStr, 10);
  }

  config.watcher = {
    use_polling: usePolling,
    polling_interval: pollingInterval,
  };
  saveConfigRaw(config);

  console.log('');
  if (usePolling) {
    console.log(`Watcher configured: polling mode enabled (interval: ${pollingInterval}ms)`);
  } else {
    console.log('Watcher configured: using native filesystem events');
  }
  console.log('Note: Restart the service for changes to take effect.');
}
