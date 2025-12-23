/**
 * Pause Command
 *
 * Pauses the syncing loop without stopping the process.
 */

import { sendSignal } from '../signals.js';
import { isAlreadyRunning, isPaused } from '../flags.js';

/**
 * Pause the sync process by sending a pause signal.
 * The process will continue running but stop processing sync jobs.
 */
export function pauseCommand(): void {
  // Check if a sync process is running first
  if (!isAlreadyRunning()) {
    console.log('No running proton-drive-sync process found.');
    return;
  }

  // Check if already paused
  if (isPaused()) {
    console.log('Sync is already paused. Use "resume" to continue syncing.');
    return;
  }

  // Send pause signal to the process
  sendSignal('pause-sync');
  console.log('Pause signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the paused flag to be set
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Flag set = process acknowledged
    if (isPaused()) {
      console.log('Syncing paused.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      console.log('Process did not respond to pause signal.');
    }
  };

  waitForAck();
}
