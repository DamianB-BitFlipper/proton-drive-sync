/**
 * Logs command to view proton-drive-sync logs
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { xdgState } from 'xdg-basedir';

if (!xdgState) {
    console.error('Could not determine XDG state directory');
    process.exit(1);
}

const STATE_DIR = join(xdgState, 'proton-drive-sync');
const LOG_PATH = join(STATE_DIR, 'sync.log');

interface LogsOptions {
    follow?: boolean;
}

export function logsCommand(options: LogsOptions): void {
    if (!existsSync(LOG_PATH)) {
        console.error(`Log file not found: ${LOG_PATH}`);
        console.error('The service may not have run yet.');
        process.exit(1);
    }

    if (options.follow) {
        // Use tail -f to follow logs
        const tail = spawn('tail', ['-f', LOG_PATH], {
            stdio: 'inherit',
        });

        tail.on('error', (err) => {
            console.error('Failed to follow logs:', err.message);
            process.exit(1);
        });

        // Handle Ctrl+C gracefully
        process.on('SIGINT', () => {
            tail.kill();
            process.exit(0);
        });
    } else {
        const content = readFileSync(LOG_PATH, 'utf-8');

        if (!content.trim()) {
            console.log('Log file is empty.');
            return;
        }

        // Print the logs
        console.log(content);
    }
}

export function logsClearCommand(): void {
    if (!existsSync(LOG_PATH)) {
        console.log('No log file to clear.');
        return;
    }

    unlinkSync(LOG_PATH);
    console.log('Logs cleared.');
}
