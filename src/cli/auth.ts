/**
 * Auth Command - Authenticate and save credentials securely
 */

import { input, password, confirm } from '@inquirer/prompts';
import {
  ProtonAuth,
  createProtonHttpClient,
  createProtonAccount,
  createSrpModule,
  createOpenPGPCrypto,
  initCrypto,
} from '../auth.js';
import type { Session } from '../auth.js';
import { storeCredentials, deleteStoredCredentials, getStoredCredentials } from '../keychain.js';
import type { StoredCredentials } from '../keychain.js';
import type { ProtonDriveClient, ApiError } from '../proton/types.js';
import { logger } from '../logger.js';
  import type { NodeData } from '../proton/types.js';

// Re-export for use in start.ts
export { getStoredCredentials } from '../keychain.js';
export type { ProtonDriveClient } from '../proton/types.js';

/**
 * Create a ProtonDriveClient from a session
 * Shared helper used by both createClientFromLogin and createClientFromTokens
 */
async function createProtonDriveClientFromSession(
  session: Session,
  onTokenRefresh: () => Promise<void>,
  sdkDebug: boolean = false
): Promise<ProtonDriveClient> {
  // Load the SDK
  type SDKModule = typeof import('@protontech/drive-sdk');
  const sdk: SDKModule = await import('@protontech/drive-sdk');

  // Import telemetry module for logging configuration (not exported from main index)
  const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

  const httpClient = createProtonHttpClient(session, onTokenRefresh);
  const openPGPCryptoModule = createOpenPGPCrypto();
  const account = createProtonAccount(session, openPGPCryptoModule);
  const srpModuleInstance = createSrpModule();

  // Create telemetry with appropriate log level
  const logLevel = sdkDebug ? telemetryModule.LogLevel.DEBUG : telemetryModule.LogLevel.ERROR;
  const telemetry = new telemetryModule.Telemetry({
    logFilter: new telemetryModule.LogFilter({ globalLevel: logLevel }),
    logHandlers: [new telemetryModule.ConsoleLogHandler()],
    metricHandlers: [], // No metrics logging
  });

  const sdkClient = new sdk.ProtonDriveClient({
    httpClient,
    entitiesCache: new sdk.MemoryCache(),
    cryptoCache: new sdk.MemoryCache(),
    // @ts-expect-error - PrivateKey types differ between openpgp imports
    account,
    // @ts-expect-error - PrivateKey types differ between openpgp imports
    openPGPCryptoModule,
    srpModule: srpModuleInstance,
    telemetry,
  });

  const getSdkRootFolder = sdkClient.getMyFilesRootFolder.bind(sdkClient);
  const iterateSdkFolderChildren = sdkClient.iterateFolderChildren.bind(sdkClient);
  const getSdkNode = sdkClient.getNode.bind(sdkClient);
  Object.defineProperty(sdkClient, 'getMyFilesRootFolder', {
    value: async () => {
      const root = await getSdkRootFolder();
      return { ok: true, value: { uid: root.uid } };
    },
  });
  Object.defineProperty(sdkClient, 'iterateFolderChildren', {
    value: async function* (folderUid: string) {
      for await (const node of iterateSdkFolderChildren(folderUid)) {
          yield { ok: true, value: normalizeSdkNode(node) };
      }
    },
  });
  Object.defineProperty(sdkClient, 'getNode', {
    value: async (nodeUid: string) => {
      const node = await getSdkNode(nodeUid);
        return { ok: true, value: normalizeSdkNode(node) };
    },
  });

  return sdkClient as unknown as ProtonDriveClient;
}

  function normalizeSdkNode(node: unknown): NodeData {
    if (!node || typeof node !== 'object') {
      throw new Error('SDK returned an invalid node');
    }

    const record = node as Record<string, unknown>;
    const nameField = record.name;
    let name: string;
    if (typeof nameField === 'string') {
      name = nameField;
    } else if (
      nameField &&
      typeof nameField === 'object' &&
      'value' in nameField &&
      typeof nameField.value === 'string'
    ) {
      name = nameField.value;
    } else {
      throw new Error('SDK returned a node with an invalid name');
    }

    return { ...record, name } as unknown as NodeData;
  }
/**
 * Create a ProtonDriveClient from username/password
 * Returns both the client and credentials for storage
 *
 * @param username - Proton username/email
 * @param pwd - Login password
 * @param mailboxPwd - Mailbox password (only for two-password mode accounts)
 * @param sdkDebug - Enable SDK debug logging
 */
export async function createClientFromLogin(
  username: string,
  pwd: string,
  mailboxPwd?: string,
  sdkDebug: boolean = false
): Promise<{ client: ProtonDriveClient; credentials: StoredCredentials }> {
  await initCrypto();

  const auth = new ProtonAuth();

  try {
    await auth.login(username, pwd);
  } catch (error) {
    const apiError = error as ApiError;

    if (apiError.requires2FA) {
      const code = await input({ message: 'Enter 2FA code (Security Key not supported):' });
      try {
        await auth.submit2FA(code);
      } catch (error2FA) {
        // After 2FA, might still need mailbox password (2FA + two-password mode)
        if ((error2FA as ApiError).requiresMailboxPassword) {
          if (!mailboxPwd) throw error2FA;
          await auth.submitMailboxPassword(mailboxPwd);
        } else {
          throw error2FA;
        }
      }
    } else if (apiError.requiresMailboxPassword) {
      // Two-password mode - need mailbox password
      if (!mailboxPwd) throw error;
      await auth.submitMailboxPassword(mailboxPwd);
    } else {
      throw error;
    }
  }

  const session = auth.getSession();
  if (!session) {
    throw new Error('Login failed: no session returned');
  }
  const credentials = auth.getReusableCredentials();

  // Create refresh callback that updates tokens and persists to keychain
  const onTokenRefresh = async () => {
    await auth.refreshToken();
    const updatedCreds = auth.getReusableCredentials();
    await storeCredentials({ ...updatedCreds, username });
    logger.info(`Token refreshed for ${username}.`);
  };

  const client = await createProtonDriveClientFromSession(session, onTokenRefresh, sdkDebug);

  return {
    client,
    credentials: { ...credentials, username },
  };
}

/**
 * Create a ProtonDriveClient from stored tokens
 */
export async function createClientFromTokens(
  credentials: StoredCredentials,
  sdkDebug: boolean = false
): Promise<ProtonDriveClient> {
  // Force re-auth for old credentials format (parent/child session model or missing passwordMode)
  const creds = credentials as unknown as Record<string, unknown>;
  if (credentials.passwordMode === undefined || creds['parentUID'] || creds['childUID']) {
    throw new Error(
      'Stored credentials are outdated. Please re-authenticate with: proton-drive-sync auth'
    );
  }

  await initCrypto();

  const auth = new ProtonAuth();
  const session = await auth.restoreSession(credentials);

  // Create refresh callback that updates tokens and persists to keychain
  const onTokenRefresh = async () => {
    await auth.refreshToken();
    const updatedCreds = auth.getReusableCredentials();
    await storeCredentials({ ...updatedCreds, username: credentials.username });
    logger.info(`Token refreshed for ${credentials.username}.`);
  };

  return createProtonDriveClientFromSession(session, onTokenRefresh, sdkDebug);
}

export async function authCommand(options: { logout?: boolean } = {}): Promise<void> {
  // Handle logout flag
  if (options.logout) {
    await deleteStoredCredentials();
    logger.info('Credentials cleared from keychain.');
    return;
  }

  // Check for existing valid authentication
  const existingCredentials = await getStoredCredentials();
  if (existingCredentials) {
    logger.info(`Existing authentication found for '${existingCredentials.username}'.`);
    logger.info('Validating session...');

    try {
      await createClientFromTokens(existingCredentials);
      logger.info('Session is valid.');

      const shouldReauth = await confirm({
        message: 'Re-authenticate anyway?',
        default: true,
      });

      if (!shouldReauth) {
        logger.info('Using existing credentials.');
        return;
      }
    } catch {
      logger.info('Existing session is invalid or expired. Re-authentication required.');
    }
  }

  // Read from environment variables first, then prompt interactively
  const username = process.env.PROTON_USERNAME || (await input({ message: 'Proton username:' }));
  const pwd = process.env.PROTON_PASSWORD || (await password({ message: 'Password:' }));
  const envMailboxPwd = process.env.PROTON_MAILBOX_PASSWORD;

  if (!username || !pwd) {
    logger.error('Username and password are required.');
    process.exit(1);
  }

  logger.info('\nAuthenticating with Proton...');

  await initCrypto();
  const auth = new ProtonAuth();

  try {
    // Step 1: Initial login
    try {
      await auth.login(username, pwd);
    } catch (error) {
      const apiError = error as ApiError;

      // Step 2: Handle 2FA if required
      if (apiError.requires2FA) {
        const code = await input({ message: 'Enter 2FA code (Security Key not supported):' });
        try {
          await auth.submit2FA(code);
        } catch (error2FA) {
          // After 2FA, might still need mailbox password
          if (!(error2FA as ApiError).requiresMailboxPassword) {
            throw error2FA;
          }
          // Fall through to mailbox password handling below
        }
      } else if (!apiError.requiresMailboxPassword) {
        throw error;
      }
    }

    // Step 3: Handle mailbox password if required (two-password mode)
    const session = auth.getSession();
    if (session?.passwordMode === 2 && !session.keyPassword) {
      logger.info('Two-password mode detected.');
      const mailboxPwd = envMailboxPwd || (await password({ message: 'Mailbox password:' }));
      await auth.submitMailboxPassword(mailboxPwd);
    }

    // Step 4: Get credentials and create client
    const finalSession = auth.getSession();
    if (!finalSession) {
      throw new Error('Login failed: no session returned');
    }
    const credentials = auth.getReusableCredentials();

    // Verify client can be created (validates the session works)
    // Use no-op refresh callback since credentials will be saved fresh below
    await createProtonDriveClientFromSession(finalSession, async () => {}, false);

    // Save tokens and username to keychain
    await deleteStoredCredentials();
    await storeCredentials({ ...credentials, username });
    logger.info('Credentials saved securely.');
  } catch (error) {
    const apiError = error as ApiError;
    const message = apiError.message || 'Unknown error';
    const code = apiError.code ? ` (code: ${apiError.code})` : '';
    logger.debug('Full authentication error:', apiError);
    logger.error(`Authentication failed${code}: ${message}`);
    process.exit(1);
  }
}
