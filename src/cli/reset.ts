/**
 * Reset Command - Delete sync state
 */

import { existsSync, unlinkSync } from 'fs';
import { confirm } from '@inquirer/prompts';
import { STATE_DIR } from '../state.js';
import { join } from 'path';

const STATE_FILE = join(STATE_DIR, 'state.json');

export async function resetCommand(): Promise<void> {
    if (!existsSync(STATE_FILE)) {
        console.log('No state file found. Nothing to reset.');
        return;
    }

    const confirmed = await confirm({
        message:
            'This will reset the sync state, forcing proton-drive-sync to sync all files as if it were first launched. Continue?',
        default: false,
    });

    if (!confirmed) {
        console.log('Aborted.');
        return;
    }

    unlinkSync(STATE_FILE);
    console.log('State reset.');
}
