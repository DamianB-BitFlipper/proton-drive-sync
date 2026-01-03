/**
 * Linux systemd service implementation
 * Supports both user-level (~/.config/systemd/user/) and system-level (/etc/systemd/system/) services
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import type { ServiceOperations, InstallScope } from './types.js';
// @ts-expect-error Bun text imports
import serviceTemplate from './templates/proton-drive-sync.service' with { type: 'text' };

const SERVICE_NAME = 'proton-drive-sync';

// Paths for user-level service
const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');
const USER_SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

// Paths for system-level service
const SYSTEMD_SYSTEM_DIR = '/etc/systemd/system';
const SYSTEM_SERVICE_PATH = join(SYSTEMD_SYSTEM_DIR, `${SERVICE_NAME}.service`);

function getServicePath(scope: InstallScope): string {
  return scope === 'system' ? SYSTEM_SERVICE_PATH : USER_SERVICE_PATH;
}

function getServiceDir(scope: InstallScope): string {
  return scope === 'system' ? SYSTEMD_SYSTEM_DIR : SYSTEMD_USER_DIR;
}

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

function generateServiceFile(binPath: string, scope: InstallScope): string {
  const home = homedir();
  let content = serviceTemplate.replace('{{BIN_PATH}}', binPath).replace(/\{\{HOME\}\}/g, home);

  if (scope === 'system') {
    const user = getCurrentUser();
    content = content.replace('{{USER_LINE}}', `User=${user}`);
  } else {
    content = content.replace('{{USER_LINE}}\n', '');
  }

  return content;
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

function createLinuxService(scope: InstallScope): ServiceOperations {
  const servicePath = getServicePath(scope);
  const serviceDir = getServiceDir(scope);

  return {
    async install(binPath: string): Promise<boolean> {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      // Create systemd directory if it doesn't exist
      if (!existsSync(serviceDir)) {
        mkdirSync(serviceDir, { recursive: true });
      }

      logger.info(`Installing proton-drive-sync service (${scope} scope)...`);

      // If service exists, stop and disable it first
      if (existsSync(servicePath)) {
        runSystemctl(scope, 'stop', SERVICE_NAME);
        runSystemctl(scope, 'disable', SERVICE_NAME);
      }

      // Write service file
      const content = generateServiceFile(binPath, scope);
      if (scope === 'system') {
        // Use writeFileSync for system scope (already running as root)
        writeFileSync(servicePath, content);
      } else {
        await Bun.write(servicePath, content);
      }
      logger.info(`Created: ${servicePath}`);

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
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      if (!existsSync(servicePath)) {
        if (interactive) {
          logger.info('No service is installed.');
        }
        return true;
      }

      logger.info(`Uninstalling proton-drive-sync service (${scope} scope)...`);

      // Stop and disable the service
      if (!this.unload()) {
        logger.warn('Failed to unload service, continuing with uninstall...');
      }

      // Remove service file
      unlinkSync(servicePath);
      daemonReload(scope);

      clearFlag(FLAGS.SERVICE_INSTALLED);
      logger.info('proton-drive-sync service uninstalled.');
      return true;
    },

    load(): boolean {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      if (!existsSync(servicePath)) {
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
      logger.info('Service loaded: will start on login');
      return true;
    },

    unload(): boolean {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      if (!existsSync(servicePath)) {
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
      logger.info('Service unloaded: will not start on login');
      return true;
    },

    isInstalled(): boolean {
      return existsSync(servicePath);
    },

    getServicePath(): string {
      return servicePath;
    },
  };
}

// Export a function that creates the service with the specified scope
export function getLinuxService(scope: InstallScope): ServiceOperations {
  return createLinuxService(scope);
}

// Default export for backward compatibility (user scope)
export const linuxService: ServiceOperations = createLinuxService('user');
