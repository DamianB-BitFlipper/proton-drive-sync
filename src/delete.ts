#!/usr/bin/env node

/**
 * Proton Drive - Delete File or Directory
 *
 * Deletes a file or directory from Proton Drive.
 * - Pass a local path (e.g., my_files/foo/bar.txt) and the corresponding remote item is deleted.
 * - If the remote item doesn't exist, does nothing (noop).
 * - By default, moves to trash. Use --permanent to delete permanently.
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 */

import { basename, dirname } from 'path';
import { input, password, confirm } from '@inquirer/prompts';
// @ts-expect-error - keychain doesn't have type definitions
import keychain from 'keychain';
import { promisify } from 'util';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// Types
// ============================================================================

interface NodeData {
    name: string;
    uid: string;
    type: string;
}

interface NodeResult {
    ok: boolean;
    value?: NodeData;
    error?: unknown;
}

interface RootFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface DeleteResult {
    ok: boolean;
    error?: unknown;
}

interface ProtonDriveClientType {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
    trashNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
    deleteNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
}

interface StoredCredentials {
    username: string;
    password: string;
}

interface ApiError extends Error {
    requires2FA?: boolean;
    code?: number;
}

// ============================================================================
// Keychain Helpers
// ============================================================================

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT_PREFIX = 'proton-drive-sync:';

const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

async function getStoredCredentials(): Promise<StoredCredentials | null> {
    try {
        const username = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
        const pwd = await keychainGetPassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
        return { username, password: pwd };
    } catch {
        return null;
    }
}

async function storeCredentials(username: string, pwd: string): Promise<void> {
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
        service: KEYCHAIN_SERVICE,
        password: username,
    });
    await keychainSetPassword({
        account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
        service: KEYCHAIN_SERVICE,
        password: pwd,
    });
}

async function deleteStoredCredentials(): Promise<void> {
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore
    }
    try {
        await keychainDeletePassword({
            account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
            service: KEYCHAIN_SERVICE,
        });
    } catch {
        // Ignore
    }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find a node (file or folder) by name in a parent folder.
 * Returns { uid, type } if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
async function findNodeByName(
    client: ProtonDriveClientType,
    parentFolderUid: string,
    name: string
): Promise<{ uid: string; type: string } | null> {
    let found: { uid: string; type: string } | null = null;
    for await (const node of client.iterateFolderChildren(parentFolderUid)) {
        if (!found && node.ok && node.value?.name === name) {
            found = { uid: node.value.uid, type: node.value.type };
        }
    }
    return found;
}

/**
 * Parse a path and return its components.
 * Strips my_files/ prefix if present.
 * Returns { parentParts: string[], name: string }
 */
function parsePath(localPath: string): { parentParts: string[]; name: string } {
    let relativePath = localPath;

    // Strip my_files/ prefix if present
    if (relativePath.startsWith('my_files/')) {
        relativePath = relativePath.slice('my_files/'.length);
    } else if (relativePath.startsWith('./my_files/')) {
        relativePath = relativePath.slice('./my_files/'.length);
    }

    // Remove trailing slash for directories
    if (relativePath.endsWith('/')) {
        relativePath = relativePath.slice(0, -1);
    }

    const name = basename(relativePath);
    const dirPath = dirname(relativePath);

    // If there's no directory (item is at root), return empty array
    if (dirPath === '.' || dirPath === '') {
        return { parentParts: [], name };
    }

    // Split by / to get folder components
    const parentParts = dirPath.split('/').filter((part) => part.length > 0);
    return { parentParts, name };
}

/**
 * Traverse the remote path and return the UID of the target folder.
 * Returns null if any part of the path doesn't exist.
 */
async function traverseRemotePath(
    client: ProtonDriveClientType,
    rootFolderUid: string,
    pathParts: string[]
): Promise<string | null> {
    let currentFolderUid = rootFolderUid;

    for (const folderName of pathParts) {
        const node = await findNodeByName(client, currentFolderUid, folderName);

        if (!node) {
            console.log(`  Path component "${folderName}" not found.`);
            return null;
        }

        if (node.type !== 'folder') {
            console.log(`  Path component "${folderName}" is not a folder.`);
            return null;
        }

        console.log(`  Found folder: ${folderName}`);
        currentFolderUid = node.uid;
    }

    return currentFolderUid;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const permanent = args.includes('--permanent');
    const localPath = args.find((arg) => !arg.startsWith('--'));

    if (!localPath) {
        console.error('Usage: npx ts-node src/delete.ts <path> [--permanent]');
        console.error('');
        console.error('Examples:');
        console.error('  npx ts-node src/delete.ts my_files/document.txt       # Move to trash');
        console.error(
            '  npx ts-node src/delete.ts my_files/photos/            # Move folder to trash'
        );
        console.error(
            '  npx ts-node src/delete.ts my_files/old.txt --permanent # Delete permanently'
        );
        process.exit(1);
    }

    const { parentParts, name } = parsePath(localPath);

    console.log(`Deleting from remote: ${localPath}`);
    console.log(`  Name: ${name}`);
    if (parentParts.length > 0) {
        console.log(`  Parent path: ${parentParts.join('/')}`);
    }
    console.log(`  Mode: ${permanent ? 'permanent delete' : 'move to trash'}`);
    console.log();

    try {
        await initCrypto();

        let username: string;
        let pwd: string;

        const storedCreds = await getStoredCredentials();

        if (storedCreds) {
            console.log(`Found stored credentials for: ${storedCreds.username}`);
            const useStored = await confirm({
                message: 'Use stored credentials?',
                default: true,
            });

            if (useStored) {
                username = storedCreds.username;
                pwd = storedCreds.password;
            } else {
                username = await input({ message: 'Proton username:' });
                pwd = await password({ message: 'Password:' });
            }
        } else {
            username = await input({ message: 'Proton username:' });
            pwd = await password({ message: 'Password:' });
        }

        if (!username || !pwd) {
            console.error('Username and password are required.');
            process.exit(1);
        }

        if (!storedCreds || storedCreds.username !== username || storedCreds.password !== pwd) {
            const saveToKeychain = await confirm({
                message: 'Save credentials to Keychain?',
                default: true,
            });

            if (saveToKeychain) {
                await deleteStoredCredentials();
                await storeCredentials(username, pwd);
                console.log('Credentials saved to Keychain.');
            }
        }

        console.log('\nAuthenticating with Proton...');
        const auth = new ProtonAuth();

        let session;
        try {
            session = await auth.login(username, pwd);
        } catch (error) {
            if ((error as ApiError).requires2FA) {
                const code = await input({ message: 'Enter 2FA code:' });
                await auth.submit2FA(code);
                session = auth.getSession();
            } else {
                throw error;
            }
        }

        console.log(`Logged in as: ${session?.user?.Name || username}\n`);

        // Load the SDK
        type SDKModule = typeof import('@protontech/drive-sdk');
        let sdk: SDKModule;
        try {
            sdk = await import('@protontech/drive-sdk');
        } catch {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            process.exit(1);
        }

        const httpClient = createProtonHttpClient(session!);
        const openPGPCryptoModule = createOpenPGPCrypto();
        const account = createProtonAccount(session!, openPGPCryptoModule);
        const srpModuleInstance = createSrpModule();

        const client: ProtonDriveClientType = new sdk.ProtonDriveClient({
            httpClient,
            entitiesCache: new sdk.MemoryCache(),
            cryptoCache: new sdk.MemoryCache(),
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            account,
            // @ts-expect-error - PrivateKey types differ between openpgp imports
            openPGPCryptoModule,
            srpModule: srpModuleInstance,
        });

        // Get root folder
        console.log('Getting root folder...');
        const rootFolder = await client.getMyFilesRootFolder();

        if (!rootFolder.ok) {
            console.error('Failed to get root folder:', rootFolder.error);
            process.exit(1);
        }

        const rootFolderUid = rootFolder.value!.uid;

        // Traverse to parent folder
        let targetFolderUid = rootFolderUid;

        if (parentParts.length > 0) {
            console.log(`Traversing path: ${parentParts.join('/')}`);
            const traverseResult = await traverseRemotePath(client, rootFolderUid, parentParts);

            if (!traverseResult) {
                console.log('\nPath does not exist on remote. Nothing to delete.');
                await auth.logout();
                return;
            }

            targetFolderUid = traverseResult;
        }

        // Find the target node
        console.log(`Looking for "${name}"...`);
        const targetNode = await findNodeByName(client, targetFolderUid, name);

        if (!targetNode) {
            console.log(`\n"${name}" does not exist on remote. Nothing to delete.`);
            await auth.logout();
            return;
        }

        console.log(`Found ${targetNode.type}: ${name} (${targetNode.uid})`);

        // Delete or trash the node
        if (permanent) {
            console.log(`Permanently deleting...`);
            for await (const result of client.deleteNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to delete: ${result.error}`);
                }
            }
            console.log(`Permanently deleted!`);
        } else {
            console.log(`Moving to trash...`);
            for await (const result of client.trashNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to trash: ${result.error}`);
                }
            }
            console.log(`Moved to trash!`);
        }

        await auth.logout();
    } catch (error) {
        console.error('\nError:', (error as Error).message);
        if ((error as ApiError).code) {
            console.error('Error code:', (error as ApiError).code);
        }
        process.exit(1);
    }
}

main();
