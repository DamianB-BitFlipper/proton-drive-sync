/**
 * Reset Command - Clear sync state from database
 */

import { confirm, select } from '@inquirer/prompts';
import { gt } from 'drizzle-orm';
import { rmSync, existsSync } from 'fs';
import { db, schema, run } from '../db/index.js';
import { logger } from '../logger.js';
import { clearAllSnapshots } from '../sync/watcher.js';
import { getConfigDir, getStateDir } from '../paths.js';
import { deleteStoredCredentials } from '../keychain.js';
import { serviceUninstallCommand } from './service/index.js';

// ============================================================================
// Main Command
// ============================================================================

export async function resetCommand(options: { purge: boolean }): Promise<void> {
  if (options.purge) {
    await purgeCommand();
    return;
  }

  // Interactive mode
  await resetInteractive();
}

// ============================================================================
// Interactive Mode
// ============================================================================

/**
 * Interactive menu for reset operations
 */
async function resetInteractive(): Promise<void> {
  while (true) {
    console.log('');
    const action = await select({
      message: 'What would you like to reset?',
      choices: [
        {
          name: 'Reset sync state',
          value: 'sync-state',
          description: 'Force full resync of all files',
        },
        {
          name: 'Clear retry delays',
          value: 'retries',
          description: 'Retry failed jobs immediately',
        },
        {
          name: 'Clear signals',
          value: 'signals',
          description: 'Clear IPC signal queue',
        },
        { name: 'Done', value: 'done' },
      ],
    });

    if (action === 'done') {
      break;
    }

    switch (action) {
      case 'sync-state':
        await resetSyncState();
        break;
      case 'retries':
        await clearRetryDelays();
        break;
      case 'signals':
        await clearSignals();
        break;
    }
  }
}

// ============================================================================
// Reset Actions
// ============================================================================

/**
 * Reset sync state - forces full resync of all files
 */
async function resetSyncState(): Promise<void> {
  const confirmed = await confirm({
    message:
      'This will reset the sync state, forcing proton-drive-sync to sync all files as if it were first launched. Continue?',
    default: false,
  });

  if (!confirmed) {
    logger.info('Aborted.');
    return;
  }

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

/**
 * Clear retry delays - allows failed jobs to be retried immediately
 */
async function clearRetryDelays(): Promise<void> {
  const confirmed = await confirm({
    message:
      'This will clear the retry delay for all pending retry jobs so they get picked up immediately. Continue?',
    default: false,
  });

  if (!confirmed) {
    logger.info('Aborted.');
    return;
  }

  const result = run(
    db.update(schema.syncJobs).set({ retryAt: new Date() }).where(gt(schema.syncJobs.nRetries, 0))
  );
  logger.info(`Cleared retry delay for ${result.changes} job(s).`);
}

/**
 * Clear signals - clears the IPC signal queue
 */
async function clearSignals(): Promise<void> {
  const confirmed = await confirm({
    message: 'This will clear all signals from the database. Continue?',
    default: false,
  });

  if (!confirmed) {
    logger.info('Aborted.');
    return;
  }

  db.delete(schema.signals).run();
  logger.info('Signals cleared.');
}

// ============================================================================
// Purge Command
// ============================================================================

/**
 * Purge all user data, credentials, and service (non-interactive)
 */
async function purgeCommand(): Promise<void> {
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
