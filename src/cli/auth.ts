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
import { storeCredentials, deleteStoredCredentials } from '../keychain.js';
import type { StoredCredentials } from '../keychain.js';
import type { ProtonDriveClient, ApiError } from '../proton/types.js';
import { logger } from '../logger.js';

// Re-export for use in start.ts
export { getStoredCredentials } from '../keychain.js';
export type { ProtonDriveClient } from '../proton/types.js';

/**
 * Create a ProtonDriveClient from username/password
 * Returns both the client and credentials for storage
 */
export async function createClientFromLogin(
  username: string,
  pwd: string,
  sdkDebug: boolean = false
): Promise<{ client: ProtonDriveClient; credentials: StoredCredentials }> {
  await initCrypto();

  const auth = new ProtonAuth();

  try {
    await auth.login(username, pwd);
  } catch (error) {
    if ((error as ApiError).requires2FA) {
      const code = await input({ message: 'Enter 2FA code (Security Key not supported):' });
      await auth.submit2FA(code);
    } else {
      throw error;
    }
  }

  const session = auth.getSession();
  const credentials = auth.getReusableCredentials();

  // Load the SDK
  type SDKModule = typeof import('@protontech/drive-sdk');
  const sdk: SDKModule = await import('@protontech/drive-sdk');

  // Import telemetry module for logging configuration (not exported from main index)
  const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

  const httpClient = createProtonHttpClient(session!);
  const openPGPCryptoModule = createOpenPGPCrypto();
  const account = createProtonAccount(session!, openPGPCryptoModule);
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

  return {
    client: client as unknown as ProtonDriveClient,
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
  await initCrypto();

  const auth = new ProtonAuth();
  const session = await auth.restoreSession(credentials);

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

export async function authCommand(): Promise<void> {
  const username = await input({ message: 'Proton username:' });
  const pwd = await password({ message: 'Password:' });

  if (!username || !pwd) {
    logger.error('Username and password are required.');
    process.exit(1);
  }

  logger.info('\nAuthenticating with Proton...');

  // Authenticate and get tokens
  try {
    const { credentials } = await createClientFromLogin(username, pwd);

    // Save tokens and username to keychain
    await deleteStoredCredentials();
    await storeCredentials(credentials);
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
