/**
 * Auth Command - Authenticate and save credentials to Keychain
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
import { storeCredentials, deleteStoredCredentials, getStoredCredentials } from '../keychain.js';
import type { ProtonDriveClient, ApiError } from '../api/types.js';
import { logger } from '../logger.js';

/**
 * Create a ProtonDriveClient from username/password
 */
export async function createClient(username: string, pwd: string): Promise<ProtonDriveClient> {
  await initCrypto();

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

  // Load the SDK
  type SDKModule = typeof import('@protontech/drive-sdk');
  const sdk: SDKModule = await import('@protontech/drive-sdk');

  // Import telemetry module for silent logging (not exported from main index)
  const telemetryModule = await import('@protontech/drive-sdk/dist/telemetry.js');

  const httpClient = createProtonHttpClient(session!);
  const openPGPCryptoModule = createOpenPGPCrypto();
  const account = createProtonAccount(session!, openPGPCryptoModule);
  const srpModuleInstance = createSrpModule();

  // Create a silent telemetry instance (only log errors)
  const silentTelemetry = new telemetryModule.Telemetry({
    logFilter: new telemetryModule.LogFilter({ globalLevel: telemetryModule.LogLevel.ERROR }),
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
    telemetry: silentTelemetry,
  });

  return client as unknown as ProtonDriveClient;
}

export async function authCommand(): Promise<void> {
  await initCrypto();

  const username = await input({ message: 'Proton username:' });
  const pwd = await password({ message: 'Password:' });

  if (!username || !pwd) {
    console.error('Username and password are required.');
    process.exit(1);
  }

  console.log('\nAuthenticating with Proton...');

  // Verify credentials work
  try {
    await createClient(username, pwd);
  } catch (error) {
    console.error('Authentication failed:', (error as Error).message);
    process.exit(1);
  }

  // Save to keychain
  await deleteStoredCredentials();
  await storeCredentials(username, pwd);
  console.log('Credentials saved to Keychain.');
}

/**
 * Authenticate using stored credentials (for sync command)
 */
export async function authenticateFromKeychain(): Promise<ProtonDriveClient> {
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
