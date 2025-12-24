/**
 * Service install/uninstall commands for macOS launchd
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import * as readline from 'readline';
import { sendSignal } from '../signals.js';

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

const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');

const WATCHMAN_SERVICE_NAME = 'com.github.watchman';
const WATCHMAN_PLIST_PATH = join(PLIST_DIR, `${WATCHMAN_SERVICE_NAME}.plist`);

const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function getWatchmanPath(): string {
  try {
    return execSync('which watchman', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('Error: watchman not found in PATH.');
    console.error('Install from: https://facebook.github.io/watchman/docs/install');
    process.exit(1);
  }
}

function getBinPath(): string {
  try {
    return execSync('which proton-drive-sync', { encoding: 'utf-8' }).trim();
  } catch {
    console.error('Error: proton-drive-sync not found in PATH.');
    console.error('Make sure the CLI is installed globally with: npm install -g proton-drive-sync');
    process.exit(1);
  }
}

function generateWatchmanPlist(watchmanPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
 "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${WATCHMAN_SERVICE_NAME}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${watchmanPath}</string>
      <string>--foreground</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
  </dict>
</plist>
`;
}

function generateSyncPlist(binPath: string): string {
  const home = homedir();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${binPath}</string>
        <string>start</string>
        <string>--watch</string>
        <string>--daemon</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${home}/Library/Logs/proton-drive-sync.out.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Library/Logs/proton-drive-sync.err.log</string>
</dict>
</plist>
`;
}

function loadService(name: string, plistPath: string): void {
  try {
    execSync(`launchctl bootstrap gui/$(id -u) "${plistPath}"`, { stdio: 'ignore' });
  } catch {
    // Already loaded, try kickstart instead
    try {
      execSync(`launchctl kickstart -k gui/$(id -u)/${name}`, { stdio: 'ignore' });
    } catch {
      // Ignore
    }
  }
}

function unloadService(name: string, plistPath: string): void {
  try {
    execSync(`launchctl bootout gui/$(id -u)/${name}`, { stdio: 'ignore' });
  } catch {
    // Try legacy unload
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
    } catch {
      // Ignore if not loaded
    }
  }
}

export async function serviceInstallCommand(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('Error: Service installation is only supported on macOS.');
    process.exit(1);
  }

  const watchmanPath = getWatchmanPath();
  const binPath = getBinPath();

  // Create LaunchAgents directory if it doesn't exist
  if (!existsSync(PLIST_DIR)) {
    mkdirSync(PLIST_DIR, { recursive: true });
  }

  let installedAny = false;

  // Ask about watchman service
  const installWatchman = await askYesNo('Install watchman service?');
  if (installWatchman) {
    console.log('Installing watchman service...');
    if (existsSync(WATCHMAN_PLIST_PATH)) {
      unloadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
    }
    writeFileSync(WATCHMAN_PLIST_PATH, generateWatchmanPlist(watchmanPath));
    console.log(`Created: ${WATCHMAN_PLIST_PATH}`);
    loadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
    console.log('Watchman service installed and started.');
    installedAny = true;
  } else {
    console.log('Skipping watchman service.');
  }

  // Ask about proton-drive-sync service
  const installSync = await askYesNo('Install proton-drive-sync service?');
  if (installSync) {
    console.log('Installing proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
      unloadService(SERVICE_NAME, PLIST_PATH);
    }
    writeFileSync(PLIST_PATH, generateSyncPlist(binPath));
    console.log(`Created: ${PLIST_PATH}`);
    loadService(SERVICE_NAME, PLIST_PATH);
    console.log('proton-drive-sync service installed and started.');
    console.log('View logs with: proton-drive-sync logs');
    installedAny = true;
  } else {
    console.log('Skipping proton-drive-sync service.');
  }

  if (!installedAny) {
    console.log('\nNo services were installed.');
  }
}

export async function serviceUninstallCommand(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('Error: Service uninstallation is only supported on macOS.');
    process.exit(1);
  }

  let uninstalledAny = false;

  // Ask about watchman service
  if (existsSync(WATCHMAN_PLIST_PATH)) {
    const uninstallWatchman = await askYesNo('Uninstall watchman service?');
    if (uninstallWatchman) {
      console.log('Uninstalling watchman service...');
      unloadService(WATCHMAN_SERVICE_NAME, WATCHMAN_PLIST_PATH);
      unlinkSync(WATCHMAN_PLIST_PATH);
      console.log('Watchman service uninstalled.');
      uninstalledAny = true;
    } else {
      console.log('Skipping watchman service.');
    }
  }

  // Ask about proton-drive-sync service
  if (existsSync(PLIST_PATH)) {
    const uninstallSync = await askYesNo('Uninstall proton-drive-sync service?');
    if (uninstallSync) {
      console.log('Uninstalling proton-drive-sync service...');
      unloadService(SERVICE_NAME, PLIST_PATH);
      unlinkSync(PLIST_PATH);
      console.log('proton-drive-sync service uninstalled.');
      uninstalledAny = true;
    } else {
      console.log('Skipping proton-drive-sync service.');
    }
  }

  if (!uninstalledAny) {
    console.log('\nNo services were uninstalled.');
  }
}

export function serviceUnloadCommand(): void {
  if (process.platform !== 'darwin') {
    console.error('Error: Service stop is only supported on macOS.');
    process.exit(1);
  }

  // Unload the service to stop it and prevent restart
  if (existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
    } catch {
      // Ignore if not loaded
    }
  }

  // Send stop signal to any running process
  sendSignal('stop');

  console.log('Service stopped and unloaded. Run `proton-drive-sync service start` to restart.');
}

export function serviceLoadCommand(): void {
  if (process.platform !== 'darwin') {
    console.error('Error: Service start is only supported on macOS.');
    process.exit(1);
  }

  if (!existsSync(PLIST_PATH)) {
    console.error('Service is not installed. Run `proton-drive-sync service install` first.');
    process.exit(1);
  }

  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'ignore' });
    console.log('Service started.');
  } catch {
    console.error('Failed to start service.');
    process.exit(1);
  }
}
