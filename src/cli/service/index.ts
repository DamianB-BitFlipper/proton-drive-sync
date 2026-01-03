/**
 * Service management - platform dispatcher
 *
 * Delegates to platform-specific implementations:
 * - macOS: launchd (LaunchAgents)
 * - Linux: systemd (user or system services)
 * - Windows: Task Scheduler
 */

import * as readline from 'readline';
import { sendSignal } from '../../signals.js';
import { hasFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import type { ServiceOperations, InstallScope } from './types.js';

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function getBinPathSafe(): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = Bun.spawnSync([cmd, 'proton-drive-sync']);
  if (result.exitCode !== 0) return null;
  const output = new TextDecoder().decode(result.stdout).trim();
  // 'where' on Windows may return multiple lines; take the first
  return output.split('\n')[0].trim();
}

function validateScope(scope: InstallScope): void {
  if (scope === 'system' && process.platform !== 'linux') {
    logger.error('System scope is only supported on Linux.');
    process.exit(1);
  }
}

async function getServiceManager(scope: InstallScope = 'user'): Promise<ServiceOperations> {
  if (process.platform === 'darwin') {
    const mod = await import('./service-macos.js');
    return mod.macosService;
  } else if (process.platform === 'linux') {
    const mod = await import('./service-linux.js');
    return mod.getLinuxService(scope);
  } else if (process.platform === 'win32') {
    const mod = await import('./service-windows.js');
    return mod.windowsService;
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function isSupportedPlatform(): boolean {
  return (
    process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
  );
}

export async function serviceInstallCommand(
  interactive: boolean = true,
  scope: InstallScope = 'user'
): Promise<void> {
  if (!isSupportedPlatform()) {
    if (interactive) {
      logger.error(`Service installation is only supported on macOS, Linux, and Windows.`);
      process.exit(1);
    }
    return;
  }

  validateScope(scope);

  const binPath = getBinPathSafe();
  if (!binPath) {
    if (interactive) {
      logger.error('proton-drive-sync not found in PATH.');
      if (process.platform === 'win32') {
        logger.error(
          'Install with: irm https://www.damianb.dev/proton-drive-sync/install.ps1 | iex'
        );
      } else {
        logger.error(
          'Install with: bash <(curl -fsSL https://www.damianb.dev/proton-drive-sync/install.sh)'
        );
      }
      process.exit(1);
    }
    return;
  }

  const service = await getServiceManager(scope);

  const installSync = interactive ? await askYesNo('Install proton-drive-sync service?') : true;
  if (installSync) {
    await service.install(binPath);
  } else {
    logger.info('Skipping proton-drive-sync service.');
  }
}

export async function serviceUninstallCommand(
  interactive: boolean = true,
  scope: InstallScope = 'user'
): Promise<void> {
  if (!isSupportedPlatform()) {
    if (interactive) {
      logger.error(`Service uninstallation is only supported on macOS, Linux, and Windows.`);
      process.exit(1);
    }
    return;
  }

  validateScope(scope);

  const service = await getServiceManager(scope);

  if (!service.isInstalled()) {
    if (interactive) {
      logger.info('No service is installed.');
    }
    return;
  }

  const uninstallSync = interactive ? await askYesNo('Uninstall proton-drive-sync service?') : true;
  if (uninstallSync) {
    await service.uninstall(interactive);
  } else {
    logger.info('Skipping proton-drive-sync service.');
  }
}

/**
 * Check if the service is installed (using flag)
 */
export function isServiceInstalled(): boolean {
  return hasFlag(FLAGS.SERVICE_INSTALLED);
}

/**
 * Load the sync service (enable start on login)
 * Returns true on success, false on failure
 */
export async function loadSyncService(scope: InstallScope = 'user'): Promise<boolean> {
  if (!isSupportedPlatform()) {
    return false;
  }

  validateScope(scope);

  const service = await getServiceManager(scope);
  return service.load();
}

/**
 * Unload the sync service (disable start on login)
 * Returns true on success, false on failure
 */
export async function unloadSyncService(scope: InstallScope = 'user'): Promise<boolean> {
  if (!isSupportedPlatform()) {
    return false;
  }

  validateScope(scope);

  const service = await getServiceManager(scope);
  return service.unload();
}

export async function serviceUnloadCommand(scope: InstallScope = 'user'): Promise<void> {
  if (!isSupportedPlatform()) {
    logger.error(`Service management is only supported on macOS, Linux, and Windows.`);
    process.exit(1);
  }

  validateScope(scope);

  if (!(await unloadSyncService(scope))) {
    logger.error('Failed to unload service.');
    process.exit(1);
  }
  sendSignal('stop');
  logger.info('Service stopped and unloaded. Run `proton-drive-sync service load` to restart.');
}

export async function serviceLoadCommand(scope: InstallScope = 'user'): Promise<void> {
  if (!isSupportedPlatform()) {
    logger.error(`Service management is only supported on macOS, Linux, and Windows.`);
    process.exit(1);
  }

  validateScope(scope);

  const service = await getServiceManager(scope);
  if (!service.isInstalled()) {
    logger.error('Service is not installed. Run `proton-drive-sync service install` first.');
    process.exit(1);
  }

  if (await loadSyncService(scope)) {
    logger.info('Service started.');
  } else {
    logger.error('Failed to start service.');
    process.exit(1);
  }
}
