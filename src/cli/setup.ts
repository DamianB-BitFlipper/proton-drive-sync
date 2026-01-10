/**
 * Setup Command - Interactive setup wizard for first-time configuration
 *
 * Guides users through:
 * 1. Remote dashboard access configuration
 * 2. Service installation (systemd/launchd)
 * 3. Authentication with Proton
 */

import { select, confirm } from '@inquirer/prompts';
import { existsSync } from 'fs';

import { getStoredCredentials } from '../keychain.js';
import { isAlreadyRunning } from '../flags.js';
import { logger } from '../logger.js';
import { getConfig, DEFAULT_DASHBOARD_PORT } from '../config.js';
import { getEffectiveHome } from '../paths.js';
import { authCommand } from './auth.js';
import { dashboardHostCommand } from './config.js';
import { serviceInstallCommand, isServiceInstalled, loadSyncService } from './service/index.js';
import type { InstallScope } from './service/types.js';

// ============================================================================
// Constants
// ============================================================================

const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// ============================================================================
// Helpers
// ============================================================================

function showBanner(): void {
  console.log(CYAN);
  console.log(
    `  ____            _                ____       _              ____                   `
  );
  console.log(
    ` |  _ \\ _ __ ___ | |_ ___  _ __   |  _ \\ _ __(_)_   _____   / ___| _   _ _ __   ___ `
  );
  console.log(
    ` | |_) | '__/ _ \\| __/ _ \\| '_ \\  | | | | '__| \\ \\ / / _ \\  \\___ \\| | | | '_ \\ / __|`
  );
  console.log(
    ` |  __/| | | (_) | || (_) | | | | | |_| | |  | |\\ V /  __/   ___) | |_| | | | | (__ `
  );
  console.log(
    ` |_|   |_|  \\___/ \\__\\___/|_| |_| |____/|_|  |_| \\_/ \\___|  |____/ \\__, |_| |_|\\___|`
  );
  console.log(
    `                                                                   |___/            `
  );
  console.log(RESET);
}

function showSection(title: string): void {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${title}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
}

function getInstalledServiceScope(): InstallScope | null {
  if (process.platform === 'linux') {
    // Check system-level first (more specific)
    if (existsSync('/etc/systemd/system/proton-drive-sync.service')) {
      return 'system';
    }
    // Check user-level
    const home = getEffectiveHome();
    if (existsSync(`${home}/.config/systemd/user/proton-drive-sync.service`)) {
      return 'user';
    }
  } else if (process.platform === 'darwin') {
    // macOS only has user-level LaunchAgents
    const home = getEffectiveHome();
    if (existsSync(`${home}/Library/LaunchAgents/com.damianb-bitflipper.proton-drive-sync.plist`)) {
      return 'user';
    }
  }
  return null;
}

function openBrowser(url: string): void {
  if (process.platform === 'darwin') {
    Bun.spawn(['open', url]);
  } else if (process.platform === 'linux') {
    const result = Bun.spawnSync(['which', 'xdg-open']);
    if (result.exitCode === 0) {
      Bun.spawn(['xdg-open', url]);
    }
  }
}

function getLocalIp(): string {
  if (process.platform === 'darwin') {
    const result = Bun.spawnSync(['ipconfig', 'getifaddr', 'en0']);
    if (result.exitCode === 0) {
      return new TextDecoder().decode(result.stdout).trim();
    }
  } else if (process.platform === 'linux') {
    const result = Bun.spawnSync(['hostname', '-I']);
    if (result.exitCode === 0) {
      const output = new TextDecoder().decode(result.stdout).trim();
      const firstIp = output.split(' ')[0];
      if (firstIp) return firstIp;
    }
  }
  return 'your-server-ip';
}

// ============================================================================
// Setup Steps
// ============================================================================

async function configureDashboard(): Promise<void> {
  showSection('Remote Dashboard Access');
  // Use the interactive config command
  await dashboardHostCommand();
}

async function configureService(): Promise<boolean> {
  showSection('Service Installation');

  const alreadyInstalled = isServiceInstalled();

  if (alreadyInstalled) {
    const reinstall = await confirm({
      message: 'Service is already installed. Reinstall?',
      default: false,
    });
    if (!reinstall) {
      logger.info('Keeping existing service configuration.');

      // Restart the service to apply any config changes
      const scope = getInstalledServiceScope();
      if (!scope) {
        logger.warn('Could not determine service scope.');
        return true;
      }

      if (process.platform === 'linux' && scope === 'system') {
        // System services require sudo to restart
        const binPath = process.execPath;
        const isRoot = process.getuid?.() === 0;
        const command = isRoot
          ? [binPath, 'service', 'load', '--install-scope', 'system']
          : ['sudo', binPath, 'service', 'load', '--install-scope', 'system'];
        logger.info('Restarting system service' + (isRoot ? '...' : ' (requires sudo)...'));
        const result = Bun.spawnSync(command, {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
          env: process.env,
        });
        return result.exitCode === 0;
      } else {
        // User services (Linux user-level or macOS) can be restarted directly
        logger.info('Restarting service...');
        return await loadSyncService(scope);
      }
    }
  }

  if (process.platform === 'linux') {
    const choice = await select({
      message: 'When should the sync service start?',
      choices: [
        { name: "Don't start automatically - manual start only", value: 'none' },
        { name: 'On login (user service) - runs when you log in', value: 'user' },
        {
          name: 'On boot (system service) - runs at system startup (requires sudo)',
          value: 'system',
        },
      ],
    });

    if (choice === 'none') {
      logger.info('Skipping automatic startup.');
      logger.info('You can start manually with: proton-drive-sync start');
      logger.info('You can enable it later with: proton-drive-sync service install');
      return false;
    } else if (choice === 'system') {
      // System-level install requires root - re-exec with sudo if not already root
      const binPath = process.execPath;
      const isRoot = process.getuid?.() === 0;
      const command = isRoot
        ? [binPath, 'service', 'install', '--install-scope', 'system']
        : ['sudo', binPath, 'service', 'install', '--install-scope', 'system'];
      if (!isRoot) {
        logger.info('System service requires root privileges. Requesting sudo...');
      }
      const result = Bun.spawnSync(command, {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
        env: process.env,
      });
      if (result.exitCode !== 0) {
        logger.error('Failed to install system service');
        return false;
      }
      return true;
    } else {
      await serviceInstallCommand(true, choice as InstallScope);
      return true;
    }
  } else if (process.platform === 'darwin') {
    const choice = await select({
      message: 'When should the sync service start?',
      choices: [
        { name: "Don't start automatically - manual start only", value: 'none' },
        { name: 'On login - runs when you log in', value: 'user' },
      ],
    });

    if (choice === 'none') {
      logger.info('Skipping automatic startup.');
      logger.info('You can start manually with: proton-drive-sync start');
      logger.info('You can enable it later with: proton-drive-sync service install');
      return false;
    } else {
      await serviceInstallCommand(true, 'user');
      return true;
    }
  }

  // Unsupported platform (Windows, etc.)
  logger.info('Automatic service installation is not available on this platform.');
  logger.info('You can start manually with: proton-drive-sync start');
  return false;
}

async function configureAuth(): Promise<void> {
  showSection('Authentication');

  const existingCredentials = await getStoredCredentials();

  if (existingCredentials) {
    const reauth = await confirm({
      message: `Already authenticated as '${existingCredentials.username}'. Re-authenticate?`,
      default: false,
    });
    if (!reauth) {
      logger.info('Keeping existing credentials.');
      return;
    }
  }

  await authCommand({});
}

async function waitForServiceAndOpenDashboard(): Promise<void> {
  showSection('Starting Service');

  logger.info('Waiting for service to start...');

  const maxAttempts = 30;
  let running = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    running = await isAlreadyRunning();
    if (running) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const config = getConfig();
  const port = config.dashboard_port ?? DEFAULT_DASHBOARD_PORT;
  const dashboardHost = config.dashboard_host ?? '127.0.0.1';

  if (running) {
    logger.info('Service started successfully!');

    // Only open browser if dashboard is local
    if (dashboardHost !== '0.0.0.0') {
      openBrowser(`http://localhost:${port}`);
    }

    console.log('');
    console.log('Complete your configuration by visiting the dashboard:');
    console.log('');
    if (dashboardHost === '0.0.0.0') {
      const localIp = getLocalIp();
      console.log(`  http://${localIp}:${port}`);
      console.log(`  (Also accessible at http://localhost:${port} on this machine)`);
    } else {
      console.log(`  http://localhost:${port}`);
    }
    console.log('');
  } else {
    logger.warn('Service did not start within 30 seconds.');
    logger.info('Check logs with: proton-drive-sync logs');
  }
}

// ============================================================================
// Main Command
// ============================================================================

export async function setupCommand(): Promise<void> {
  showBanner();

  // Step 1: Dashboard configuration (uses interactive config command)
  await configureDashboard();

  // Step 2: Service installation
  const serviceInstalled = await configureService();

  // Step 3: Authentication
  await configureAuth();

  // Step 4: Wait for service and show dashboard URL
  if (serviceInstalled || (await isAlreadyRunning())) {
    await waitForServiceAndOpenDashboard();
  } else {
    showSection('Setup Complete');
    console.log('  To start syncing, run:');
    console.log('');
    console.log('    proton-drive-sync start');
    console.log('');
    console.log('  Then visit the dashboard to configure sync directories:');
    console.log('');
    const config = getConfig();
    const port = config.dashboard_port ?? DEFAULT_DASHBOARD_PORT;
    console.log(`    http://localhost:${port}`);
    console.log('');
  }

  logger.info('Setup complete!');
}
