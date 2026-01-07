/**
 * Setup Command - Interactive setup wizard for first-time configuration
 *
 * Guides users through:
 * 1. Remote dashboard access configuration
 * 2. Service installation (systemd/launchd)
 * 3. Authentication with Proton
 */

import { select, confirm } from '@inquirer/prompts';
import { getStoredCredentials } from '../keychain.js';
import { isAlreadyRunning } from '../flags.js';
import { logger } from '../logger.js';
import {
  loadConfig,
  ensureConfigDir,
  CONFIG_FILE,
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
} from '../config.js';
import type { Config } from '../config.js';
import { writeFileSync, existsSync } from 'fs';
import { authCommand } from './auth.js';
import { serviceInstallCommand, isServiceInstalled } from './service/index.js';
import type { InstallScope } from './service/types.js';

// ============================================================================
// Constants
// ============================================================================

const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
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

function loadOrCreateConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    ensureConfigDir();
    const defaultConfig: Config = {
      sync_dirs: [],
      sync_concurrency: 4,
    };
    writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
    logger.info(`Created default config file: ${CONFIG_FILE}`);
    return defaultConfig;
  }
  return loadConfig();
}

function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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

async function configureDashboard(config: Config): Promise<Config> {
  showSection('Remote Dashboard Access');

  console.log('  The dashboard is available at localhost:4242 by default.');
  console.log('');
  console.log('  For headless/server installs, you can enable remote access by binding');
  console.log('  the web interface to all network interfaces (0.0.0.0:4242).');
  console.log('');
  console.log(`  ${YELLOW}WARNING: This exposes the dashboard to your network.${RESET}`);
  console.log('  The dashboard allows service control and configuration changes.');
  console.log('  Only enable this on trusted networks or behind a firewall.');
  console.log('');

  const currentlyRemote = config.dashboard_host === '0.0.0.0';

  const enableRemote = await confirm({
    message: 'Enable remote dashboard access?',
    default: currentlyRemote,
  });

  config.dashboard_host = enableRemote ? '0.0.0.0' : DEFAULT_DASHBOARD_HOST;
  saveConfig(config);

  if (enableRemote) {
    logger.info('Remote dashboard access enabled (0.0.0.0:4242)');
  } else {
    logger.info('Dashboard will only be accessible locally (localhost:4242)');
  }

  return config;
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
      return true;
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

  // On Linux, set KEYRING_PASSWORD for file-based credential storage
  if (process.platform === 'linux') {
    process.env.KEYRING_PASSWORD = 'proton-drive-sync';
  }

  await authCommand({});
}

async function waitForServiceAndOpenDashboard(config: Config): Promise<void> {
  showSection('Starting Service');

  logger.info('Waiting for service to start...');

  const maxAttempts = 30;
  let running = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    running = await isAlreadyRunning();
    if (running) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const port = config.dashboard_port ?? DEFAULT_DASHBOARD_PORT;
  const dashboardHost = config.dashboard_host ?? DEFAULT_DASHBOARD_HOST;

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

  // Load or create config
  let config = loadOrCreateConfig();

  // Step 1: Dashboard configuration
  config = await configureDashboard(config);

  // Step 2: Service installation
  const serviceInstalled = await configureService();

  // Step 3: Authentication
  await configureAuth();

  // Step 4: Wait for service and show dashboard URL
  if (serviceInstalled || (await isAlreadyRunning())) {
    await waitForServiceAndOpenDashboard(config);
  } else {
    showSection('Setup Complete');
    console.log('  To start syncing, run:');
    console.log('');
    console.log('    proton-drive-sync start');
    console.log('');
    console.log('  Then visit the dashboard to configure sync directories:');
    console.log('');
    const port = config.dashboard_port ?? DEFAULT_DASHBOARD_PORT;
    console.log(`    http://localhost:${port}`);
    console.log('');
  }

  logger.info('Setup complete!');
}
