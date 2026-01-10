/**
 * Proton Drive Sync - Status Command
 *
 * Returns JSON status of the sync service
 */

import { isAlreadyRunning, isPaused } from '../flags.js';
import { getConfig } from '../config.js';

// ============================================================================
// Types
// ============================================================================

interface StatusResult {
  status: 'running' | 'stopped';
  paused: boolean;
  port: number;
}

// ============================================================================
// Command
// ============================================================================

export async function statusCommand(): Promise<void> {
  const config = getConfig();
  const running = await isAlreadyRunning();
  const paused = running ? await isPaused() : false;
  const port = config.dashboard_port;

  const result: StatusResult = {
    status: running ? 'running' : 'stopped',
    paused,
    port,
  };

  console.log(JSON.stringify(result));
}
