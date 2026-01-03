/**
 * Proton Drive Sync - Configuration
 *
 * Reads config from ~/.config/proton-drive-sync/config.json
 * Supports hot-reloading via namespaced signals (config:reload:<key>)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from './logger.js';
import { getConfigDir } from './paths.js';
import { registerSignalHandler, sendSignal } from './signals.js';

// ============================================================================
// Types
// ============================================================================

export interface SyncDir {
  source_path: string;
  remote_root: string;
}

export interface Config {
  sync_dirs: SyncDir[];
  sync_concurrency: number;
  dashboard_host?: string;
  dashboard_port?: number;
}

/** Config keys that can be watched for changes */
export type ConfigKey = keyof Config;

// ============================================================================
// Constants
// ============================================================================

/** Base signal prefix for config reload */
export const CONFIG_RELOAD_SIGNAL = 'config:reload';

/** Signal to trigger config reload check */
export const CONFIG_CHECK_SIGNAL = 'config:check';

/** Default sync concurrency */
export const DEFAULT_SYNC_CONCURRENCY = 4;

/** Default dashboard host (localhost only) */
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';

/** Default dashboard port */
export const DEFAULT_DASHBOARD_PORT = 4242;

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export { CONFIG_DIR, CONFIG_FILE };

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// ============================================================================
// Config Singleton
// ============================================================================

let currentConfig: Config | null = null;

/**
 * Parse and validate config from file. Returns null if invalid.
 */
function parseConfig(exitOnError: boolean): Config | null {
  if (!existsSync(CONFIG_FILE)) {
    ensureConfigDir();
    const defaultConfig: Config = {
      sync_dirs: [],
      sync_concurrency: DEFAULT_SYNC_CONCURRENCY,
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    logger.info(`Created default config file: ${CONFIG_FILE}`);
    return defaultConfig;
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as Config;

    if (!config.sync_dirs) {
      config.sync_dirs = [];
    } else if (!Array.isArray(config.sync_dirs)) {
      const msg = 'Config "sync_dirs" must be an array';
      if (exitOnError) {
        logger.error(msg);
        process.exit(1);
      }
      logger.error(msg);
      return null;
    }

    // Default sync_concurrency if not set
    if (config.sync_concurrency === undefined) {
      config.sync_concurrency = DEFAULT_SYNC_CONCURRENCY;
    }

    // Validate all sync_dirs entries
    for (const dir of config.sync_dirs) {
      if (typeof dir === 'string') {
        const msg =
          'Config sync_dirs must be objects with "source_path" and "remote_root" properties';
        if (exitOnError) {
          logger.error(msg);
          logger.error(
            'Example: {"sync_dirs": [{"source_path": "/path/to/dir", "remote_root": "/backup"}]}'
          );
          process.exit(1);
        }
        logger.error(msg);
        return null;
      }
      if (!dir.source_path) {
        const msg = 'Each sync_dirs entry must have a "source_path" property';
        if (exitOnError) {
          console.error(msg);
          process.exit(1);
        }
        logger.error(msg);
        return null;
      }

      // Ensure remote_root starts with '/'
      if (!dir.remote_root) {
        dir.remote_root = '/';
      } else if (!dir.remote_root.startsWith('/')) {
        dir.remote_root = '/' + dir.remote_root;
      }

      if (!existsSync(dir.source_path)) {
        const msg = `Sync directory does not exist: ${dir.source_path}`;
        if (exitOnError) {
          console.error(msg);
          process.exit(1);
        }
        logger.error(msg);
        return null;
      }
    }

    return config;
  } catch (error) {
    let msg: string;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      msg = `Config file not found: ${CONFIG_FILE}`;
    } else if (error instanceof SyntaxError) {
      msg = `Invalid JSON in config file: ${CONFIG_FILE}`;
    } else {
      msg = `Error reading config: ${(error as Error).message}`;
    }
    if (exitOnError) {
      console.error(msg);
      process.exit(1);
    }
    logger.error(msg);
    return null;
  }
}

/**
 * Load config from file. Exits process if config is invalid on first load.
 */
export function loadConfig(): Config {
  if (currentConfig) {
    return currentConfig;
  }
  currentConfig = parseConfig(true)!;
  return currentConfig;
}

/**
 * Get the current config. Must call loadConfig() first.
 */
export function getConfig(): Config {
  if (!currentConfig) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return currentConfig;
}

/**
 * Check if a path is within any of the configured sync directories.
 */
export function isPathWatched(localPath: string): boolean {
  if (!currentConfig) {
    return false;
  }
  return currentConfig.sync_dirs.some((dir) => localPath.startsWith(dir.source_path));
}

/** Check if two values are deeply equal (for sync_dirs array comparison) */
function isEqual<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reload config from file and send signals for changed keys.
 */
function reloadConfig(): void {
  const oldConfig = currentConfig;
  const newConfig = parseConfig(false);
  if (!newConfig) {
    logger.warn('Config reload failed, keeping previous config');
    return;
  }

  currentConfig = newConfig;
  logger.info('Config reloaded');

  if (!oldConfig) return;

  // Send signals for keys that changed
  const keys: ConfigKey[] = ['sync_dirs', 'sync_concurrency', 'dashboard_host', 'dashboard_port'];
  for (const key of keys) {
    if (!isEqual(oldConfig[key], newConfig[key])) {
      logger.debug(`Config key "${key}" changed, sending signal`);
      sendSignal(`${CONFIG_RELOAD_SIGNAL}:${key}`);
    }
  }
}

/**
 * Register a handler for changes to a specific config key.
 * Handler is called when config:reload:<key> signal is received.
 */
export function onConfigChange(key: ConfigKey, handler: () => void): void {
  registerSignalHandler(`${CONFIG_RELOAD_SIGNAL}:${key}`, handler);
}

/**
 * Start watching for config check signals.
 * When received, reloads config and sends signals for changed keys.
 */
export function watchConfig(): void {
  registerSignalHandler(CONFIG_CHECK_SIGNAL, reloadConfig);
}
