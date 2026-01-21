/**
 * macOS launchd service implementation
 */

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import { getEffectiveHome, chownToEffectiveUser } from '../../paths.js';
import type { ServiceOperations, ServiceResult, ServiceInstallOptions } from './types.js';
// @ts-expect-error Bun text imports
import plistTemplate from './templates/proton-drive-sync.plist' with { type: 'text' };

const PLIST_DIR = join(getEffectiveHome(), 'Library', 'LaunchAgents');
const SERVICE_NAME = 'com.damianb-bitflipper.proton-drive-sync';
const PLIST_PATH = join(PLIST_DIR, `${SERVICE_NAME}.plist`);

function generatePlist(binPath: string): string {
  const home = getEffectiveHome();
  return plistTemplate
    .replace('{{SERVICE_NAME}}', SERVICE_NAME)
    .replace('{{BIN_PATH}}', binPath)
    .replace(/\{\{HOME\}\}/g, home);
}

function loadService(name: string, plistPath: string): ServiceResult {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootstrap = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plistPath]);

  if (bootstrap.exitCode === 0) {
    return { success: true };
  }

  // Bootstrap failed - check if already loaded (exit code 37 = "Service already loaded")
  const bootstrapStderr = new TextDecoder().decode(bootstrap.stderr).trim();
  const alreadyLoaded =
    bootstrap.exitCode === 37 ||
    bootstrap.exitCode === 5 ||
    bootstrapStderr.includes('already loaded');

  if (alreadyLoaded) {
    // Already loaded, try kickstart to restart it
    const kickstart = Bun.spawnSync(['launchctl', 'kickstart', '-k', `gui/${uid}/${name}`]);
    if (kickstart.exitCode === 0) {
      return { success: true };
    }

    // Exit code 37 from kickstart can mean service is already running - treat as success
    if (kickstart.exitCode === 37) {
      logger.warn('Service already running (kickstart exit code 37)');
      return { success: true };
    }

    const kickstartStderr = new TextDecoder().decode(kickstart.stderr).trim();
    return {
      success: false,
      error: `Failed to kickstart service: ${kickstartStderr || `exit code ${kickstart.exitCode}`}`,
    };
  }

  return {
    success: false,
    error: `Failed to bootstrap service: ${bootstrapStderr || `exit code ${bootstrap.exitCode}`}\nService may already be loaded. Try \`proton-drive-sync service unload\` then \`service load\`.`,
  };
}

function unloadServiceInternal(name: string, plistPath: string): ServiceResult {
  const uid = new TextDecoder().decode(Bun.spawnSync(['id', '-u']).stdout).trim();
  const bootout = Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${name}`]);

  if (bootout.exitCode === 0) {
    return { success: true };
  }

  // Bootout failed - check if not loaded (exit code 113 = "Could not find specified service")
  const bootoutStderr = new TextDecoder().decode(bootout.stderr).trim();
  const notLoaded = bootout.exitCode === 113 || bootoutStderr.includes('Could not find');

  if (notLoaded) {
    // Service wasn't loaded, that's fine
    return { success: true };
  }

  // Try legacy unload as fallback
  const unload = Bun.spawnSync(['launchctl', 'unload', plistPath]);
  if (unload.exitCode === 0) {
    return { success: true };
  }

  const unloadStderr = new TextDecoder().decode(unload.stderr).trim();
  return {
    success: false,
    error: `Failed to unload service: ${bootoutStderr || unloadStderr || `exit code ${bootout.exitCode}`}`,
  };
}

export const macosService: ServiceOperations = {
  async install(binPath: string, _options?: ServiceInstallOptions): Promise<boolean> {
    // Create LaunchAgents directory if it doesn't exist
    if (!existsSync(PLIST_DIR)) {
      mkdirSync(PLIST_DIR, { recursive: true });
      chownToEffectiveUser(PLIST_DIR);
    }

    logger.info('Installing proton-drive-sync service...');
    if (existsSync(PLIST_PATH)) {
      unloadServiceInternal(SERVICE_NAME, PLIST_PATH);
    }
    await Bun.write(PLIST_PATH, generatePlist(binPath));
    chownToEffectiveUser(PLIST_PATH);
    logger.info(`Created: ${PLIST_PATH}`);
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
    if (!existsSync(PLIST_PATH)) {
      if (interactive) {
        logger.info('No service is installed.');
      }
      return true;
    }

    logger.info('Uninstalling proton-drive-sync service...');
    if (!this.unload()) {
      logger.warn('Failed to unload service, continuing with uninstall...');
    }
    unlinkSync(PLIST_PATH);
    clearFlag(FLAGS.SERVICE_INSTALLED);
    logger.info('proton-drive-sync service uninstalled.');
    return true;
  },

  load(): boolean {
    if (!existsSync(PLIST_PATH)) {
      return false;
    }

    const result = loadService(SERVICE_NAME, PLIST_PATH);
    if (result.success) {
      setFlag(FLAGS.SERVICE_LOADED);
      logger.info('Service loaded: will start on login');
      return true;
    } else {
      logger.error(result.error ?? 'Failed to load service');
      return false;
    }
  },

  unload(): boolean {
    if (!existsSync(PLIST_PATH)) {
      clearFlag(FLAGS.SERVICE_LOADED);
      return true;
    }

    const result = unloadServiceInternal(SERVICE_NAME, PLIST_PATH);
    if (result.success) {
      clearFlag(FLAGS.SERVICE_LOADED);
      logger.info('Service unloaded: will not start on login');
      return true;
    } else {
      logger.error(result.error ?? 'Failed to unload service');
      return false;
    }
  },

  isInstalled(): boolean {
    return existsSync(PLIST_PATH);
  },

  getServicePath(): string {
    return PLIST_PATH;
  },
};
