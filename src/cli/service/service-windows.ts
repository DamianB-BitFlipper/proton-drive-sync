/**
 * Windows Task Scheduler service implementation
 *
 * Uses schtasks.exe to manage a scheduled task that runs at user logon.
 */

import { logger } from '../../logger.js';
import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import type { ServiceOperations, ServiceInstallOptions } from './types.js';

const TASK_NAME = 'ProtonDriveSync';

interface SchtasksResult {
  success: boolean;
  output: string;
}

function runSchtasks(...args: string[]): SchtasksResult {
  const result = Bun.spawnSync(['schtasks', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return {
    success: result.exitCode === 0,
    output: stdout + stderr,
  };
}

async function install(binPath: string, _options?: ServiceInstallOptions): Promise<boolean> {
  // Create task that runs at user logon
  // /rl limited = run with limited privileges (no admin elevation)
  // /f = force overwrite if exists
  const { success, output } = runSchtasks(
    '/create',
    '/tn',
    TASK_NAME,
    '/tr',
    `"${binPath}" start`,
    '/sc',
    'onlogon',
    '/rl',
    'limited',
    '/f'
  );

  if (success) {
    setFlag(FLAGS.SERVICE_INSTALLED);

    // Auto-start the service (same behavior as macOS/Linux)
    if (load()) {
      logger.info('proton-drive-sync service installed and started.');
      return true;
    } else {
      logger.error('proton-drive-sync service installed but failed to start.');
      return false;
    }
  } else {
    logger.error(`Failed to install service: ${output}`);
  }
  return success;
}

async function uninstall(interactive: boolean): Promise<boolean> {
  if (!isInstalled()) {
    if (interactive) logger.info('No service is installed.');
    return true;
  }

  // Stop the task first if running
  await unload();

  // Delete the scheduled task
  const { success, output } = runSchtasks('/delete', '/tn', TASK_NAME, '/f');

  if (success) {
    clearFlag(FLAGS.SERVICE_INSTALLED);
    clearFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service uninstalled successfully.');
  } else {
    logger.error(`Failed to uninstall service: ${output}`);
  }
  return success;
}

function load(): boolean {
  // Run the scheduled task immediately
  const { success, output } = runSchtasks('/run', '/tn', TASK_NAME);

  if (success) {
    setFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service started.');
  } else {
    logger.error(`Failed to start service: ${output}`);
  }
  return success;
}

function unload(): boolean {
  // End/stop the running task
  const { success } = runSchtasks('/end', '/tn', TASK_NAME);
  clearFlag(FLAGS.SERVICE_LOADED);
  // Don't log errors here - task may not be running
  return success;
}

function isInstalled(): boolean {
  // Query if the task exists
  const { success } = runSchtasks('/query', '/tn', TASK_NAME);
  return success;
}

function getServicePath(): string {
  // Windows Task Scheduler doesn't use a file path like launchd/systemd
  // Return a descriptive string instead
  return `Task Scheduler: ${TASK_NAME}`;
}

export const windowsService: ServiceOperations = {
  install,
  uninstall,
  load,
  unload,
  isInstalled,
  getServicePath,
};
