/**
 * Linux systemd service implementation
 * Supports both user-level (~/.config/systemd/user/) and system-level (/etc/systemd/system/) services
 * Uses file-based encrypted credential storage (no gnome-keyring dependency)
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { password as passwordPrompt } from '@inquirer/prompts';
import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import type { ServiceOperations, InstallScope } from './types.js';
// @ts-expect-error Bun text imports
import serviceTemplate from './templates/proton-drive-sync.service' with { type: 'text' };

// ============================================================================
// Constants
// ============================================================================

const SERVICE_NAME = 'proton-drive-sync';

// ============================================================================
// Path Helpers
// ============================================================================

interface ServicePaths {
  serviceDir: string;
  servicePath: string;
  dataDir: string;
}

function getPaths(scope: InstallScope): ServicePaths {
  const home = homedir();

  if (scope === 'system') {
    return {
      serviceDir: '/etc/systemd/system',
      servicePath: '/etc/systemd/system/proton-drive-sync.service',
      dataDir: '/etc/proton-drive-sync',
    };
  }

  return {
    serviceDir: join(home, '.config', 'systemd', 'user'),
    servicePath: join(home, '.config', 'systemd', 'user', 'proton-drive-sync.service'),
    dataDir: join(home, '.config', 'proton-drive-sync'),
  };
}

// ============================================================================
// System Helpers
// ============================================================================

function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

function getCurrentUser(): string {
  // When running as root via sudo, SUDO_USER contains the original user
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser) {
    return sudoUser;
  }
  // Fallback to whoami
  const result = Bun.spawnSync(['whoami']);
  return new TextDecoder().decode(result.stdout).trim();
}

function getCurrentUid(): number {
  // When running as root via sudo, get the UID of the original user
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid) {
    return parseInt(sudoUid, 10);
  }
  return process.getuid?.() ?? 1000;
}

function runSystemctl(
  scope: InstallScope,
  ...args: string[]
): { success: boolean; error?: string } {
  const systemctlArgs =
    scope === 'user' ? ['systemctl', '--user', ...args] : ['systemctl', ...args];
  const result = Bun.spawnSync(systemctlArgs);
  if (result.exitCode === 0) {
    return { success: true };
  }
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return { success: false, error: stderr || `exit code ${result.exitCode}` };
}

function daemonReload(scope: InstallScope): boolean {
  const result = runSystemctl(scope, 'daemon-reload');
  return result.success;
}

// ============================================================================
// Encryption Password Prompt
// ============================================================================

async function promptEncryptionPassword(): Promise<string> {
  console.log('');
  console.log(
    '⚠️  WARNING: The encryption password will be stored in CLEARTEXT in the service file.'
  );
  console.log('This is required for automated credential decryption in headless environments.');
  console.log('');

  const encryptionPassword = await passwordPrompt({ message: 'Enter encryption password:' });
  const confirm = await passwordPrompt({ message: 'Confirm encryption password:' });

  if (encryptionPassword !== confirm) {
    throw new Error('Passwords do not match');
  }

  if (!encryptionPassword) {
    throw new Error('Password cannot be empty');
  }

  return encryptionPassword;
}

// ============================================================================
// Service File Generation
// ============================================================================

function generateServiceFile(binPath: string, password: string, scope: InstallScope): string {
  const home = homedir();
  const uid = getCurrentUid();

  let content = serviceTemplate
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home)
    .replace(/\{\{UID\}\}/g, String(uid))
    .replace('{{KEYRING_PASSWORD}}', password)
    .replace('{{WANTED_BY}}', scope === 'system' ? 'multi-user.target' : 'default.target');

  if (scope === 'system') {
    const user = getCurrentUser();
    content = content.replace('{{USER_LINE}}', `User=${user}`);
  } else {
    content = content.replace('{{USER_LINE}}\n', '');
  }

  return content;
}

// ============================================================================
// Main Service Operations
// ============================================================================

function createLinuxService(scope: InstallScope): ServiceOperations {
  const paths = getPaths(scope);

  return {
    async install(binPath: string, encryptionPassword?: string): Promise<boolean> {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      // Prompt for encryption password if not provided
      let password = encryptionPassword;
      if (!password) {
        try {
          password = await promptEncryptionPassword();
        } catch (error) {
          logger.error(
            `Encryption password error: ${error instanceof Error ? error.message : error}`
          );
          return false;
        }
      }

      // Create systemd directory if it doesn't exist
      if (!existsSync(paths.serviceDir)) {
        mkdirSync(paths.serviceDir, { recursive: true });
      }

      // Create data directory if it doesn't exist
      if (!existsSync(paths.dataDir)) {
        mkdirSync(paths.dataDir, { recursive: true });
      }

      logger.info(`Installing proton-drive-sync service (${scope} scope)...`);

      // If service exists, stop and disable it first
      if (existsSync(paths.servicePath)) {
        runSystemctl(scope, 'stop', SERVICE_NAME);
        runSystemctl(scope, 'disable', SERVICE_NAME);
      }

      // Write main service file
      const content = generateServiceFile(binPath, password, scope);
      writeFileSync(paths.servicePath, content);
      logger.info(`Created: ${paths.servicePath}`);

      // Reload systemd to pick up new service
      if (!daemonReload(scope)) {
        logger.error('Failed to reload systemd daemon');
        return false;
      }

      setFlag(FLAGS.SERVICE_INSTALLED);

      if (this.load()) {
        logger.info('proton-drive-sync service installed and started.');
        return true;
      } else {
        logger.error('proton-drive-sync service installed but failed to start.');
        return false;
      }
    },

    async uninstall(interactive: boolean): Promise<boolean> {
      // Check both user and system level for installed services
      const userPaths = getPaths('user');
      const systemPaths = getPaths('system');

      const hasUserService = existsSync(userPaths.servicePath);
      const hasSystemService = existsSync(systemPaths.servicePath);

      if (!hasUserService && !hasSystemService) {
        if (interactive) {
          logger.info('No service is installed.');
        }
        return true;
      }

      // Check if we need root for system service
      if (hasSystemService && !isRunningAsRoot()) {
        logger.error('System service found. Run with sudo to uninstall.');
        return false;
      }

      // Uninstall user-level service if it exists
      if (hasUserService) {
        logger.info('Uninstalling user-level service...');

        // Stop and disable the service
        runSystemctl('user', 'stop', SERVICE_NAME);
        runSystemctl('user', 'disable', SERVICE_NAME);

        // Remove service file
        if (existsSync(userPaths.servicePath)) {
          unlinkSync(userPaths.servicePath);
          logger.info(`Removed: ${userPaths.servicePath}`);
        }

        daemonReload('user');
      }

      // Uninstall system-level service if it exists
      if (hasSystemService) {
        logger.info('Uninstalling system-level service...');

        // Stop and disable the service
        runSystemctl('system', 'stop', SERVICE_NAME);
        runSystemctl('system', 'disable', SERVICE_NAME);

        // Remove service file
        if (existsSync(systemPaths.servicePath)) {
          unlinkSync(systemPaths.servicePath);
          logger.info(`Removed: ${systemPaths.servicePath}`);
        }

        daemonReload('system');
      }

      clearFlag(FLAGS.SERVICE_INSTALLED);
      clearFlag(FLAGS.SERVICE_LOADED);
      logger.info('proton-drive-sync service uninstalled.');
      return true;
    },

    load(): boolean {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      if (!existsSync(paths.servicePath)) {
        return false;
      }

      // Enable and start the service
      const enableResult = runSystemctl(scope, 'enable', SERVICE_NAME);
      if (!enableResult.success) {
        logger.error(`Failed to enable service: ${enableResult.error}`);
        return false;
      }

      const startResult = runSystemctl(scope, 'start', SERVICE_NAME);
      if (!startResult.success) {
        logger.error(`Failed to start service: ${startResult.error}`);
        return false;
      }

      setFlag(FLAGS.SERVICE_LOADED);
      logger.info(`Service loaded: will start on ${scope === 'system' ? 'boot' : 'login'}`);
      return true;
    },

    unload(): boolean {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      if (!existsSync(paths.servicePath)) {
        clearFlag(FLAGS.SERVICE_LOADED);
        return true;
      }

      // Stop the service
      const stopResult = runSystemctl(scope, 'stop', SERVICE_NAME);
      if (!stopResult.success) {
        // Service might not be running, that's OK
        logger.debug(`Stop result: ${stopResult.error}`);
      }

      // Disable the service
      const disableResult = runSystemctl(scope, 'disable', SERVICE_NAME);
      if (!disableResult.success) {
        logger.error(`Failed to disable service: ${disableResult.error}`);
        return false;
      }

      clearFlag(FLAGS.SERVICE_LOADED);
      logger.info(`Service unloaded: will not start on ${scope === 'system' ? 'boot' : 'login'}`);
      return true;
    },

    isInstalled(): boolean {
      return existsSync(paths.servicePath);
    },

    getServicePath(): string {
      return paths.servicePath;
    },
  };
}

// Export a function that creates the service with the specified scope
export function getLinuxService(scope: InstallScope): ServiceOperations {
  return createLinuxService(scope);
}

// Default export for backward compatibility (user scope)
export const linuxService: ServiceOperations = createLinuxService('user');
