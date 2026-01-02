/**
 * Auth Command - Authenticate and save credentials securely
 */

import { input, password } from '@inquirer/prompts';
import {
  ProtonAuth,
  createProtonHttpClient,
  createProtonAccount,
  createSrpModule,
  createOpenPGPCrypto,
  initCrypto,
} from '../auth.js';
import type { Session } from '../auth.js';
import { storeCredentials, deleteStoredCredentials } from '../keychain.js';
import type { StoredCredentials } from '../keychain.js';
import type { ProtonDriveClient, ApiError } from '../proton/types.js';
import { logger } from '../logger.js';

// Re-export for use in start.ts
export { getStoredCredentials } from '../keychain.js';
export type { ProtonDriveClient } from '../proton/types.js';

/**
 * Create a ProtonDriveClient from a session
 * Shared helper used by both createClientFromLogin and createClientFromTokens
 */
async function createProtonDriveClientFromSession(
  session: Session,
  sdkDebug: boolean = false
): Promise<ProtonDriveClient> {
  // Load the SDK
  type SDKModule = typeof import('@protontech/drive-sdk');
  const sdk: SDKModule = await import('@protontech/drive-sdk');

  // Import telemetry module for logging configuration (not exported from main index)
  const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

  const httpClient = createProtonHttpClient(session);
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

  const client = new sdk.ProtonDriveClient({
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

  return client as unknown as ProtonDriveClient;
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

  const client = await createProtonDriveClientFromSession(session, sdkDebug);

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
  // Force re-auth for old credentials without passwordMode
  if (credentials.passwordMode === undefined) {
    throw new Error(
      'Stored credentials are outdated. Please re-authenticate with: proton-drive-sync auth'
    );
  }

  await initCrypto();

  const auth = new ProtonAuth();
  const session = await auth.restoreSession(credentials);

  return createProtonDriveClientFromSession(session, sdkDebug);
}

export async function authCommand(): Promise<void> {
  // Read from environment variables first, then prompt interactively
  const username = process.env.PROTON_USERNAME || (await input({ message: 'Proton username:' }));
  const pwd = process.env.PROTON_PASSWORD || (await password({ message: 'Password:' }));
  const envMailboxPwd = process.env.PROTON_MAILBOX_PASSWORD;

  if (!username || !pwd) {
    logger.error('Username and password are required.');
    process.exit(1);
  }

  logger.info('\nAuthenticating with Proton...');

  // Authenticate and get tokens
  try {
    const { credentials } = await createClientFromLogin(username, pwd, envMailboxPwd);

    // Save tokens and username to keychain
    await deleteStoredCredentials();
    await storeCredentials(credentials);
    logger.info('Credentials saved securely.');
  } catch (error) {
    const apiError = error as ApiError;

    if (apiError.requiresMailboxPassword) {
      // Two-password mode detected - prompt for mailbox password
      logger.info('Two-password mode detected.');
      const mailboxPwd = envMailboxPwd || (await password({ message: 'Mailbox password:' }));

      try {
        const { credentials } = await createClientFromLogin(username, pwd, mailboxPwd);

        // Save tokens and username to keychain
        await deleteStoredCredentials();
        await storeCredentials(credentials);
        logger.info('Credentials saved securely.');
      } catch (innerError) {
        const innerApiError = innerError as ApiError;
        const message = innerApiError.message || 'Unknown error';
        const code = innerApiError.code ? ` (code: ${innerApiError.code})` : '';
        logger.debug('Full authentication error:', innerApiError);
        logger.error(`Authentication failed${code}: ${message}`);
        process.exit(1);
      }
    } else {
      const message = apiError.message || 'Unknown error';
      const code = apiError.code ? ` (code: ${apiError.code})` : '';
      logger.debug('Full authentication error:', apiError);
      logger.error(`Authentication failed${code}: ${message}`);
      process.exit(1);
    }
  }
}
