/**
 * Linux systemd service implementation
 * Supports both user-level (~/.config/systemd/user/) and system-level (/etc/systemd/system/) services
 * Includes keyring setup for headless credential storage
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { password as passwordPrompt } from '@inquirer/prompts';
import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import type { ServiceOperations, InstallScope } from './types.js';
// @ts-expect-error Bun text imports
import serviceTemplate from './templates/proton-drive-sync.service' with { type: 'text' };
// @ts-expect-error Bun text imports
import keyringServiceTemplate from './templates/proton-drive-sync-keyring.service' with { type: 'text' };
// @ts-expect-error Bun text imports
import keyringInitTemplate from './templates/keyring-init.sh' with { type: 'text' };

// ============================================================================
// Constants
// ============================================================================

const SERVICE_NAME = 'proton-drive-sync';
const KEYRING_SERVICE_NAME = 'proton-drive-sync-keyring';

// Required packages for keyring functionality
const REQUIRED_PACKAGES_DEBIAN = ['libsecret-1-0', 'gnome-keyring', 'dbus-x11'];
const REQUIRED_PACKAGES_FEDORA = ['libsecret', 'gnome-keyring', 'dbus-x11'];

// ============================================================================
// Path Helpers
// ============================================================================

interface ServicePaths {
  serviceDir: string;
  servicePath: string;
  keyringServicePath: string;
  keyringInitScript: string;
  keyringEnvFile: string;
  keyringDir: string;
  dataDir: string;
}

function getPaths(scope: InstallScope): ServicePaths {
  const home = homedir();

  if (scope === 'system') {
    return {
      serviceDir: '/etc/systemd/system',
      servicePath: '/etc/systemd/system/proton-drive-sync.service',
      keyringServicePath: '/etc/systemd/system/proton-drive-sync-keyring.service',
      keyringInitScript: '/etc/proton-drive-sync/keyring-init.sh',
      keyringEnvFile: '/etc/proton-drive-sync/keyring.env',
      keyringDir: '/var/lib/proton-drive-sync/keyrings',
      dataDir: '/etc/proton-drive-sync',
    };
  }

  return {
    serviceDir: join(home, '.config', 'systemd', 'user'),
    servicePath: join(home, '.config', 'systemd', 'user', 'proton-drive-sync.service'),
    keyringServicePath: join(
      home,
      '.config',
      'systemd',
      'user',
      'proton-drive-sync-keyring.service'
    ),
    keyringInitScript: join(home, '.local', 'share', 'proton-drive-sync', 'keyring-init.sh'),
    keyringEnvFile: join(home, '.local', 'share', 'proton-drive-sync', 'keyring.env'),
    keyringDir: join(home, '.local', 'share', 'keyrings'),
    dataDir: join(home, '.local', 'share', 'proton-drive-sync'),
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
// Dependency Checking
// ============================================================================

function detectPackageManager(): 'apt' | 'dnf' | 'unknown' {
  if (Bun.spawnSync(['which', 'apt']).exitCode === 0) {
    return 'apt';
  }
  if (Bun.spawnSync(['which', 'dnf']).exitCode === 0) {
    return 'dnf';
  }
  return 'unknown';
}

function checkPackageInstalled(pkg: string, packageManager: 'apt' | 'dnf' | 'unknown'): boolean {
  if (packageManager === 'apt') {
    const result = Bun.spawnSync(['dpkg-query', '-W', '-f=${Status}', pkg]);
    const output = new TextDecoder().decode(result.stdout);
    return output.includes('install ok installed');
  }
  if (packageManager === 'dnf') {
    const result = Bun.spawnSync(['rpm', '-q', pkg]);
    return result.exitCode === 0;
  }
  // Unknown package manager - assume installed
  return true;
}

function checkDependencies(): { missing: string[]; installCommand: string } {
  const packageManager = detectPackageManager();
  const packages = packageManager === 'dnf' ? REQUIRED_PACKAGES_FEDORA : REQUIRED_PACKAGES_DEBIAN;

  const missing: string[] = [];
  for (const pkg of packages) {
    if (!checkPackageInstalled(pkg, packageManager)) {
      missing.push(pkg);
    }
  }

  let installCommand = '';
  if (missing.length > 0) {
    if (packageManager === 'apt') {
      installCommand = `sudo apt install ${missing.join(' ')}`;
    } else if (packageManager === 'dnf') {
      installCommand = `sudo dnf install ${missing.join(' ')}`;
    } else {
      installCommand = `Install packages: ${missing.join(', ')}`;
    }
  }

  return { missing, installCommand };
}

// ============================================================================
// Keyring Password Prompt
// ============================================================================

async function promptKeyringPassword(): Promise<string> {
  console.log('');
  console.log('⚠️  WARNING: The keyring password will be stored in CLEARTEXT in the service file.');
  console.log('This is required for automated keyring unlocking in headless environments.');
  console.log('');

  const keyringPassword = await passwordPrompt({ message: 'Enter keyring password:' });
  const confirm = await passwordPrompt({ message: 'Confirm keyring password:' });

  if (keyringPassword !== confirm) {
    throw new Error('Passwords do not match');
  }

  if (!keyringPassword) {
    throw new Error('Password cannot be empty');
  }

  return keyringPassword;
}

// ============================================================================
// Service File Generation
// ============================================================================

function generateKeyringInitScript(password: string, scope: InstallScope): string {
  const paths = getPaths(scope);

  return keyringInitTemplate
    .replace('{{KEYRING_DIR}}', paths.keyringDir)
    .replace('{{KEYRING_ENV_FILE}}', paths.keyringEnvFile)
    .replace('{{KEYRING_PASSWORD}}', password);
}

function generateKeyringServiceFile(scope: InstallScope): string {
  const paths = getPaths(scope);
  const home = homedir();
  const uid = getCurrentUid();

  let content = keyringServiceTemplate
    .replace('{{KEYRING_INIT_SCRIPT}}', paths.keyringInitScript)
    .replace('{{HOME}}', home)
    .replace(/\{\{UID\}\}/g, String(uid))
    .replace('{{WANTED_BY}}', scope === 'system' ? 'multi-user.target' : 'default.target');

  if (scope === 'system') {
    const user = getCurrentUser();
    content = content.replace('{{USER_LINE}}', `User=${user}`);
  } else {
    content = content.replace('{{USER_LINE}}\n', '');
  }

  return content;
}

function generateServiceFile(binPath: string, scope: InstallScope): string {
  const paths = getPaths(scope);
  const home = homedir();
  const uid = getCurrentUid();

  let content = serviceTemplate
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home)
    .replace(/\{\{UID\}\}/g, String(uid))
    .replace('{{KEYRING_ENV_FILE}}', paths.keyringEnvFile)
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
// Keyring Service Management
// ============================================================================

function installKeyringService(password: string, scope: InstallScope): boolean {
  const paths = getPaths(scope);

  // Create data directory for keyring init script
  if (!existsSync(paths.dataDir)) {
    mkdirSync(paths.dataDir, { recursive: true });
  }

  // Create keyring directory
  if (!existsSync(paths.keyringDir)) {
    mkdirSync(paths.keyringDir, { recursive: true });
  }

  // Write keyring init script
  const keyringInitContent = generateKeyringInitScript(password, scope);
  writeFileSync(paths.keyringInitScript, keyringInitContent);
  chmodSync(paths.keyringInitScript, 0o700); // rwx------
  logger.info(`Created: ${paths.keyringInitScript}`);

  // Write keyring service file
  const keyringServiceContent = generateKeyringServiceFile(scope);
  writeFileSync(paths.keyringServicePath, keyringServiceContent);
  logger.info(`Created: ${paths.keyringServicePath}`);

  return true;
}

function uninstallKeyringService(scope: InstallScope): boolean {
  const paths = getPaths(scope);

  // Stop and disable keyring service
  runSystemctl(scope, 'stop', KEYRING_SERVICE_NAME);
  runSystemctl(scope, 'disable', KEYRING_SERVICE_NAME);

  // Remove keyring service file
  if (existsSync(paths.keyringServicePath)) {
    unlinkSync(paths.keyringServicePath);
    logger.info(`Removed: ${paths.keyringServicePath}`);
  }

  // Remove keyring init script
  if (existsSync(paths.keyringInitScript)) {
    unlinkSync(paths.keyringInitScript);
    logger.info(`Removed: ${paths.keyringInitScript}`);
  }

  // Remove keyring env file
  if (existsSync(paths.keyringEnvFile)) {
    unlinkSync(paths.keyringEnvFile);
    logger.info(`Removed: ${paths.keyringEnvFile}`);
  }

  return true;
}

function loadKeyringService(scope: InstallScope): boolean {
  const paths = getPaths(scope);

  if (!existsSync(paths.keyringServicePath)) {
    return false;
  }

  // Enable keyring service
  const enableResult = runSystemctl(scope, 'enable', KEYRING_SERVICE_NAME);
  if (!enableResult.success) {
    logger.error(`Failed to enable keyring service: ${enableResult.error}`);
    return false;
  }

  // Start keyring service
  const startResult = runSystemctl(scope, 'start', KEYRING_SERVICE_NAME);
  if (!startResult.success) {
    logger.error(`Failed to start keyring service: ${startResult.error}`);
    return false;
  }

  return true;
}

function unloadKeyringService(scope: InstallScope): boolean {
  const paths = getPaths(scope);

  if (!existsSync(paths.keyringServicePath)) {
    return true;
  }

  // Stop keyring service
  runSystemctl(scope, 'stop', KEYRING_SERVICE_NAME);

  // Disable keyring service
  const disableResult = runSystemctl(scope, 'disable', KEYRING_SERVICE_NAME);
  if (!disableResult.success) {
    logger.debug(`Failed to disable keyring service: ${disableResult.error}`);
  }

  return true;
}

// ============================================================================
// Main Service Operations
// ============================================================================

function createLinuxService(scope: InstallScope): ServiceOperations {
  const paths = getPaths(scope);

  return {
    async install(binPath: string, keyringPassword?: string): Promise<boolean> {
      // System scope requires root
      if (scope === 'system' && !isRunningAsRoot()) {
        logger.error('System scope requires running with sudo');
        return false;
      }

      // Check dependencies
      const { missing, installCommand } = checkDependencies();
      if (missing.length > 0) {
        logger.error(`Missing required packages: ${missing.join(', ')}`);
        logger.error(`Install them with: ${installCommand}`);
        return false;
      }

      // Prompt for keyring password if not provided
      let password = keyringPassword;
      if (!password) {
        try {
          password = await promptKeyringPassword();
        } catch (error) {
          logger.error(`Keyring password error: ${error instanceof Error ? error.message : error}`);
          return false;
        }
      }

      // Create systemd directory if it doesn't exist
      if (!existsSync(paths.serviceDir)) {
        mkdirSync(paths.serviceDir, { recursive: true });
      }

      logger.info(`Installing proton-drive-sync service (${scope} scope)...`);

      // If services exist, stop and disable them first
      if (existsSync(paths.servicePath)) {
        runSystemctl(scope, 'stop', SERVICE_NAME);
        runSystemctl(scope, 'disable', SERVICE_NAME);
      }
      if (existsSync(paths.keyringServicePath)) {
        runSystemctl(scope, 'stop', KEYRING_SERVICE_NAME);
        runSystemctl(scope, 'disable', KEYRING_SERVICE_NAME);
      }

      // Install keyring service first
      if (!installKeyringService(password, scope)) {
        logger.error('Failed to install keyring service');
        return false;
      }

      // Write main service file
      const content = generateServiceFile(binPath, scope);
      writeFileSync(paths.servicePath, content);
      logger.info(`Created: ${paths.servicePath}`);

      // Reload systemd to pick up new services
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

      const hasUserService =
        existsSync(userPaths.servicePath) || existsSync(userPaths.keyringServicePath);
      const hasSystemService =
        existsSync(systemPaths.servicePath) || existsSync(systemPaths.keyringServicePath);

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

        // Stop and disable the main service
        runSystemctl('user', 'stop', SERVICE_NAME);
        runSystemctl('user', 'disable', SERVICE_NAME);

        // Remove main service file
        if (existsSync(userPaths.servicePath)) {
          unlinkSync(userPaths.servicePath);
          logger.info(`Removed: ${userPaths.servicePath}`);
        }

        // Uninstall keyring service
        uninstallKeyringService('user');

        daemonReload('user');
      }

      // Uninstall system-level service if it exists
      if (hasSystemService) {
        logger.info('Uninstalling system-level service...');

        // Stop and disable the main service
        runSystemctl('system', 'stop', SERVICE_NAME);
        runSystemctl('system', 'disable', SERVICE_NAME);

        // Remove main service file
        if (existsSync(systemPaths.servicePath)) {
          unlinkSync(systemPaths.servicePath);
          logger.info(`Removed: ${systemPaths.servicePath}`);
        }

        // Uninstall keyring service
        uninstallKeyringService('system');

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

      // Load keyring service first
      if (!loadKeyringService(scope)) {
        logger.error('Failed to load keyring service');
        return false;
      }

      // Enable and start the main service
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

      // Stop the main service first
      const stopResult = runSystemctl(scope, 'stop', SERVICE_NAME);
      if (!stopResult.success) {
        // Service might not be running, that's OK
        logger.debug(`Stop result: ${stopResult.error}`);
      }

      // Disable the main service
      const disableResult = runSystemctl(scope, 'disable', SERVICE_NAME);
      if (!disableResult.success) {
        logger.error(`Failed to disable service: ${disableResult.error}`);
        return false;
      }

      // Unload keyring service
      unloadKeyringService(scope);

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
