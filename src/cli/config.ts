/**
 * Config Command - Open dashboard settings page
 */

import { isAlreadyRunning } from '../flags.js';
import { startDashboard } from '../dashboard/server.js';
import { loadConfig } from '../config.js';

const SETTINGS_URL = 'http://localhost:4242/settings';

export function configCommand(): void {
  if (isAlreadyRunning()) {
    console.log(`Dashboard is already running. Open settings at:\n\n  ${SETTINGS_URL}\n`);
    return;
  }

  // Start just the dashboard (not the sync client)
  const config = loadConfig();
  startDashboard(config);
  console.log(`Dashboard started. Open settings at:\n\n  ${SETTINGS_URL}\n`);

  // Keep process alive
  process.on('SIGINT', () => {
    console.log('Stopping dashboard...');
    process.exit(0);
  });
}
