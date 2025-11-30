/**
 * Sync Command - Watch and sync files to Proton Drive
 */

import { realpathSync } from 'fs';
import { basename } from 'path';
import watchman from 'fb-watchman';
import pRetry from 'p-retry';
import { getStoredCredentials } from '../keychain.js';
import { appState, saveState } from '../state.js';
import { loadConfig, type Config } from '../config.js';
import { logger, enableVerbose } from '../logger.js';
import { createClient } from './auth.js';
import { createNode } from '../create.js';
import { deleteNode } from '../delete.js';
import type { ProtonDriveClient } from '../types.js';

// ============================================================================
// Types
// ============================================================================

interface FileChange {
    name: string;
    size: number;
    mtime_ms: number;
    exists: boolean;
    type: 'f' | 'd';
    watchRoot: string; // Which watch root this change came from
    clock?: string; // The clock value to save after processing this change (daemon mode)
}

// ============================================================================
// Constants
// ============================================================================

const SUB_NAME = 'proton-drive-sync';

// Debounce time in ms - wait for rapid changes to settle
const DEBOUNCE_MS = 500;

// ============================================================================
// Options
// ============================================================================

let dryRun = false;
let watchMode = false;
let remoteRoot = '';

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

// ============================================================================
// Change Queue & Processing
// ============================================================================

// Queue of pending changes (path -> latest change info)
const pendingChanges = new Map<string, FileChange>();
let debounceTimer: NodeJS.Timeout | null = null;
let protonClient: ProtonDriveClient | null = null;
let isProcessing = false;

// Track completion for one-shot mode
let pendingQueries = 0;
let oneShotResolve: (() => void) | null = null;

/**
 * Save clock for a change if in daemon mode and clock is present
 */
function saveClockIfNeeded(change: FileChange): void {
    if (watchMode && change.clock && !dryRun) {
        appState.clocks[change.watchRoot] = change.clock;
        saveState(appState);
    }
}

async function processChanges(): Promise<void> {
    if (isProcessing || !protonClient) return;
    isProcessing = true;

    // Take snapshot of current pending changes
    const changes = new Map(pendingChanges);
    pendingChanges.clear();

    for (const [path, change] of changes) {
        // Build local path (where to read from)
        const localPath = `${change.watchRoot}/${path}`;
        // Build remote path (where to upload to on Proton Drive)
        const dirName = basename(change.watchRoot);
        const remotePath = remoteRoot ? `${remoteRoot}/${dirName}/${path}` : `${dirName}/${path}`;

        try {
            if (change.exists) {
                // File or directory was created/modified
                const typeLabel = change.type === 'd' ? 'directory' : 'file';

                if (dryRun) {
                    logger.info(`[DRY-RUN] Would create/update ${typeLabel}: ${path}`);
                    continue;
                }

                logger.info(`Creating/updating ${typeLabel}: ${path}`);

                const result = await pRetry(
                    async () => {
                        const res = await createNode(protonClient!, localPath, remotePath);
                        if (!res.success) {
                            throw new Error(res.error);
                        }
                        return res;
                    },
                    {
                        retries: 3,
                        onFailedAttempt: (ctx) => {
                            logger.warn(
                                `Create attempt ${ctx.attemptNumber} failed for ${remotePath}: ${ctx.error.message}. ${ctx.retriesLeft} retries left.`
                            );
                        },
                    }
                );
                logger.info(`Success: ${path} -> ${result.nodeUid}`);
                saveClockIfNeeded(change);
            } else {
                // File or directory was deleted
                if (dryRun) {
                    logger.info(`[DRY-RUN] Would delete: ${path}`);
                    continue;
                }

                logger.info(`Deleting: ${path}`);

                const result = await pRetry(
                    async () => {
                        const res = await deleteNode(protonClient!, remotePath, false);
                        if (!res.success) {
                            throw new Error(res.error);
                        }
                        return res;
                    },
                    {
                        retries: 3,
                        onFailedAttempt: (ctx) => {
                            logger.warn(
                                `Delete attempt ${ctx.attemptNumber} failed for ${remotePath}: ${ctx.error.message}. ${ctx.retriesLeft} retries left.`
                            );
                        },
                    }
                );
                if (result.existed) {
                    logger.info(`Deleted: ${path}`);
                } else {
                    logger.info(`Already gone: ${path}`);
                }
                saveClockIfNeeded(change);
            }
        } catch (error) {
            // All retries exhausted - log error and continue, still save clock to avoid retrying forever
            logger.error(`Failed after 3 retries for ${path}: ${(error as Error).message}`);
            saveClockIfNeeded(change);
        }
    }

    isProcessing = false;

    // If more changes came in while processing, schedule another run
    if (pendingChanges.size > 0) {
        scheduleProcessing();
    } else if (!watchMode && oneShotResolve) {
        // One-shot mode: resolve when all changes processed
        oneShotResolve();
    }
}

function scheduleProcessing(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processChanges();
    }, DEBOUNCE_MS);
}

function queueChange(file: FileChange): void {
    const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
    const typeLabel = file.type === 'd' ? 'dir' : 'file';
    logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);

    pendingChanges.set(file.name, file);
    scheduleProcessing();
}

// ============================================================================
// Authentication
// ============================================================================

/**
 * Authenticate using stored credentials (for sync command)
 */
async function authenticateFromKeychain(): Promise<ProtonDriveClient> {
    const storedCreds = await getStoredCredentials();

    if (!storedCreds) {
        logger.error('No credentials found. Run `proton-drive-sync auth` first.');
        process.exit(1);
    }

    logger.info(`Authenticating as ${storedCreds.username}...`);
    const client = await createClient(storedCreds.username, storedCreds.password);
    logger.info('Authenticated.');

    return client;
}

// ============================================================================
// One-shot Sync (query mode)
// ============================================================================

function runOneShotSync(config: Config): Promise<void> {
    return new Promise((resolve) => {
        oneShotResolve = resolve;
        pendingQueries = config.sync_dirs.length;

        for (const dir of config.sync_dirs) {
            const watchDir = realpathSync(dir);

            watchmanClient.command(['watch-project', watchDir], (err, resp) => {
                if (err) {
                    logger.error(`Watchman error for ${dir}: ${err}`);
                    process.exit(1);
                }

                const watchResp = resp as watchman.WatchProjectResponse;
                const root = watchResp.watch;
                const relative = watchResp.relative_path || '';

                const savedClock = appState.clocks[watchDir];

                if (savedClock) {
                    logger.info(`Syncing changes since last run for ${dir}...`);
                } else {
                    logger.info(`First run - syncing all existing files in ${dir}...`);
                }

                // Build query
                const query: Record<string, unknown> = {
                    expression: ['anyof', ['type', 'f'], ['type', 'd']],
                    fields: ['name', 'size', 'mtime_ms', 'exists', 'type'],
                };

                if (savedClock) {
                    query.since = savedClock;
                }

                if (relative) {
                    query.relative_root = relative;
                }

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (watchmanClient as any).command(
                    ['query', root, query],
                    (err: Error | null, resp: any) => {
                        if (err) {
                            logger.error(`Query error for ${dir}: ${err}`);
                            process.exit(1);
                        }

                        // Save clock
                        if (resp.clock && !dryRun) {
                            appState.clocks[watchDir] = resp.clock;
                            saveState(appState);
                        }

                        // Queue changes
                        const files = resp.files || [];
                        for (const file of files) {
                            const fileChange = file as Omit<FileChange, 'watchRoot'>;
                            queueChange({ ...fileChange, watchRoot: watchDir });
                        }

                        pendingQueries--;

                        // If no changes and all queries done, resolve
                        if (pendingQueries === 0 && pendingChanges.size === 0 && !isProcessing) {
                            logger.info('No changes to sync.');
                            resolve();
                        }
                    }
                );
            });
        }
    });
}

// ============================================================================
// Daemon Mode (subscription mode)
// ============================================================================

function setupWatchmanDaemon(config: Config): void {
    // Set up watches for all configured directories
    for (const dir of config.sync_dirs) {
        const watchDir = realpathSync(dir);
        const subName = `${SUB_NAME}-${basename(watchDir)}`;

        // Step 1: Find root (watch-project)
        watchmanClient.command(['watch-project', watchDir], (err, resp) => {
            if (err) {
                logger.error(`Watchman error for ${dir}: ${err}`);
                process.exit(1);
            }

            const watchResp = resp as watchman.WatchProjectResponse;
            const root = watchResp.watch;
            const relative = watchResp.relative_path || '';

            // Step 2: Use saved clock for this directory or null for initial sync
            const savedClock = appState.clocks[watchDir];

            if (savedClock) {
                logger.info(`Resuming ${dir} from last sync state...`);
            } else {
                logger.info(`First run - syncing all existing files in ${dir}...`);
            }

            // Step 3: Build a subscription query
            const sub: Record<string, unknown> = {
                expression: ['anyof', ['type', 'f'], ['type', 'd']], // files and directories
                fields: ['name', 'size', 'mtime_ms', 'exists', 'type'],
            };

            // Only set 'since' if we have a saved clock (otherwise get all files)
            if (savedClock) {
                sub.since = savedClock;
            }

            if (relative) {
                sub.relative_root = relative;
            }

            // Step 4: Register subscription
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (watchmanClient as any).command(
                ['subscribe', root, subName, sub],
                (err: Error | null) => {
                    if (err) {
                        logger.error(`Subscribe error for ${dir}: ${err}`);
                        process.exit(1);
                    }
                    logger.info(`Watching ${dir} for changes...`);
                }
            );
        });
    }

    // Step 5: Listen for notifications from all subscriptions
    watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
        // Check if this is one of our subscriptions
        if (!resp.subscription.startsWith(SUB_NAME)) return;

        // Extract the watch root from the subscription name
        const dirName = resp.subscription.replace(`${SUB_NAME}-`, '');
        const watchRoot = config.sync_dirs.find((d) => basename(realpathSync(d)) === dirName) || '';
        const resolvedRoot = realpathSync(watchRoot);

        // Get clock from this notification (will be saved after each file is processed)
        const clock = (resp as unknown as { clock?: string }).clock;

        for (const file of resp.files) {
            const fileChange = file as unknown as Omit<FileChange, 'watchRoot' | 'clock'>;
            queueChange({ ...fileChange, watchRoot: resolvedRoot, clock });
        }
    });

    // Step 6: Handle errors & shutdown
    watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
    watchmanClient.on('end', () => {});

    logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

// ============================================================================
// Command
// ============================================================================

export async function syncCommand(options: {
    verbose: boolean;
    dryRun: boolean;
    watch: boolean;
}): Promise<void> {
    if (options.verbose || options.dryRun) {
        enableVerbose();
    }

    if (options.dryRun) {
        dryRun = true;
        logger.info('[DRY-RUN] Dry run mode enabled - no changes will be made');
    }

    watchMode = options.watch;

    // Load config
    const config = loadConfig();

    // Set remote root from config
    remoteRoot = config.remote_root;

    // Authenticate using stored credentials
    protonClient = await authenticateFromKeychain();

    if (watchMode) {
        // Daemon mode: use subscriptions and keep running
        setupWatchmanDaemon(config);

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            logger.info('Shutting down...');
            watchmanClient.end();
            process.exit(0);
        });
    } else {
        // One-shot mode: query for changes, process, and exit
        await runOneShotSync(config);
        watchmanClient.end();
    }
}
