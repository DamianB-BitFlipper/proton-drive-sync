/**
 * Reset Command - Clear sync state from database
 */

import { confirm } from '@inquirer/prompts';
import { gt } from 'drizzle-orm';
import { rmSync, existsSync } from 'fs';
import { db, schema, run } from '../db/index.js';
import { logger } from '../logger.js';
import { clearAllSnapshots } from '../sync/watcher.js';
import { getConfigDir, getStateDir } from '../paths.js';
import { deleteStoredCredentials } from '../keychain.js';
import { serviceUninstallCommand } from './service/index.js';

export async function resetCommand(options: {
  yes: boolean;
  signals: boolean;
  retries: boolean;
  purge: boolean;
}): Promise<void> {
  const { yes, signals: signalsOnly, retries: retriesOnly, purge } = options;

  // --purge is mutually exclusive with --signals and --retries
  if (purge && (signalsOnly || retriesOnly)) {
    logger.error('--purge cannot be used with --signals or --retries');
    process.exit(1);
  }

  if (purge) {
    await purgeCommand(yes);
    return;
  }

  if (!yes) {
    let message: string;
    if (retriesOnly) {
      message =
        'This will clear the retry delay for all pending retry jobs so they get picked up immediately. Continue?';
    } else if (signalsOnly) {
      message = 'This will clear all signals from the database. Continue?';
    } else {
      message =
        'This will reset the sync state, forcing proton-drive-sync to sync all files as if it were first launched. Continue?';
    }

    const confirmed = await confirm({
      message,
      default: false,
    });

    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  }

  if (retriesOnly) {
    const result = run(
      db.update(schema.syncJobs).set({ retryAt: new Date() }).where(gt(schema.syncJobs.nRetries, 0))
    );
    logger.info(`Cleared retry delay for ${result.changes} job(s).`);
  } else if (signalsOnly) {
    db.delete(schema.signals).run();
    logger.info('Signals cleared.');
  } else {
    // Clear all sync-related tables atomically
    db.transaction((tx) => {
      tx.delete(schema.syncJobs).run();
      tx.delete(schema.processingQueue).run();
      tx.delete(schema.fileState).run();
      tx.delete(schema.nodeMapping).run();
    });

    // Clear file state to force full resync
    const snapshotsCleared = clearAllSnapshots();
    if (snapshotsCleared > 0) {
      logger.info(`Cleared ${snapshotsCleared} file state entry(ies).`);
    }

    logger.info('State reset.');
  }
}

/**
 * Purge all user data, credentials, and service
 */
async function purgeCommand(skipConfirmation: boolean): Promise<void> {
  if (!skipConfirmation) {
    const confirmed = await confirm({
      message:
        'This will completely remove all proton-drive-sync data including credentials, configuration, and sync history. This cannot be undone. Continue?',
      default: false,
    });

    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  }

  logger.info('');
  logger.info('Purging proton-drive-sync...');
  logger.info('');

  // Step 1: Uninstall service (non-interactive, ignore errors)
  try {
    logger.info('Removing service...');
    await serviceUninstallCommand(false);
  } catch {
    // Service may not be installed, ignore
  }

  // Step 2: Clear stored credentials from keychain
  try {
    logger.info('Clearing stored credentials...');
    await deleteStoredCredentials();
    logger.info('Credentials cleared.');
  } catch {
    // May not have credentials stored, ignore
  }

  // Step 3: Delete config directory
  const configDir = getConfigDir();
  if (existsSync(configDir)) {
    try {
      rmSync(configDir, { recursive: true, force: true });
      logger.info(`Removed configuration: ${configDir}`);
    } catch (err) {
      logger.warn(
        `Failed to remove ${configDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Step 4: Delete state directory
  const stateDir = getStateDir();
  if (existsSync(stateDir)) {
    try {
      rmSync(stateDir, { recursive: true, force: true });
      logger.info(`Removed state/sync history: ${stateDir}`);
    } catch (err) {
      logger.warn(
        `Failed to remove ${stateDir}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info('');
  logger.info('Purge complete. All proton-drive-sync data has been removed.');
}
