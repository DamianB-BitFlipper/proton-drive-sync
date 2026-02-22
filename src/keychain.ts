/**
 * Keychain utilities for storing and retrieving Proton credentials
 *
 * Cross-platform secure credential storage:
 * - macOS: Keychain (via @napi-rs/keyring)
 * - Windows: Credential Manager (via @napi-rs/keyring)
 * - Linux: Secret Service / keyutils (via @napi-rs/keyring)
 * - Fallback: File-based encrypted storage (only if native keyring unavailable)
 */

import { Entry } from '@napi-rs/keyring';
import { createHash } from 'crypto';
import { hostname, platform, arch } from 'os';
import { logger } from './logger.js';
import type { PasswordMode } from './auth.js';
import {
  storeCredentialsToFile,
  getCredentialsFromFile,
  deleteCredentialsFile,
} from './keychain-file.js';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT = 'proton-drive-sync:tokens';

import { KeychainBackends } from './keychain-backends.js';
import type { KeychainBackend } from './keychain-backends.js';

/**
 * Check if native keyring is available and working.
 * Tries to access the OS credential store and falls back to file-based storage if unavailable.
 */
let nativeKeychainAvailable: boolean | null = null;
let backendNoticeLogged = false;

function parseKeychainBackend(raw?: string): KeychainBackend {
  const value = raw?.toLowerCase();
  if (
    value === KeychainBackends.NATIVE ||
    value === KeychainBackends.FILE ||
    value === KeychainBackends.AUTO
  ) {
    return value as KeychainBackend;
  }

  if (raw) {
    logger.warn(`Ignoring invalid KEYCHAIN_BACKEND value: ${raw} (using ${KeychainBackends.AUTO})`);
  }

  return KeychainBackends.AUTO;
}

const keychainBackend: KeychainBackend = parseKeychainBackend(process.env.KEYCHAIN_BACKEND);

function shouldUseNativeKeychain(): boolean {
  if (keychainBackend === KeychainBackends.FILE) {
    if (!backendNoticeLogged) {
      logger.info(
        `Using file-based credential storage (KEYCHAIN_BACKEND=${KeychainBackends.FILE}).`
      );
      backendNoticeLogged = true;
    }
    nativeKeychainAvailable = false;
    return false;
  }

  const available = isNativeKeychainAvailable();

  if (!backendNoticeLogged && keychainBackend === KeychainBackends.NATIVE && !available) {
    logger.warn(
      `KEYCHAIN_BACKEND=${KeychainBackends.NATIVE} requested, but native keyring is unavailable. Using encrypted file storage instead.`
    );
    backendNoticeLogged = true;
  }

  if (!backendNoticeLogged && available) {
    logger.debug(
      keychainBackend === KeychainBackends.NATIVE
        ? `Using native keychain (KEYCHAIN_BACKEND=${KeychainBackends.NATIVE}).`
        : 'Using native keychain (auto-detected).'
    );
    backendNoticeLogged = true;
  }

  return available;
}

function isNativeKeychainAvailable(): boolean {
  // Cache the result to avoid repeated checks
  if (nativeKeychainAvailable !== null) {
    return nativeKeychainAvailable;
  }

  try {
    // Try to create a test entry to verify native keychain works
    const testEntry = new Entry(KEYCHAIN_SERVICE, '__test_availability__');

    // Try a simple operation
    testEntry.deleteCredential();

    nativeKeychainAvailable = true;
    logger.debug('Native keychain is available');
    return true;
  } catch (error) {
    logger.debug(`Native keychain not available: ${error}`);
    logger.warn(
      'Native keyring unavailable. Using file-based encryption. ' +
        'For better security, ensure Secret Service (libsecret) is installed on Linux.'
    );
    nativeKeychainAvailable = false;
    return false;
  }
}

/**
 * Get the keyring password for file-based storage fallback.
 * Uses KEYRING_PASSWORD env var if set, otherwise generates a machine-specific password.
 */
function getKeyringPassword(): string {
  if (process.env.KEYRING_PASSWORD) {
    return process.env.KEYRING_PASSWORD;
  }

  // Generate a deterministic password based on machine ID
  // This is better than a hardcoded default, though still relies on file permissions
  const machineId = `${hostname()}-${platform()}-${arch()}`;
  return createHash('sha256').update(machineId).digest('hex');
}

/** Tokens stored in keychain for session reuse (parent/child session model) */
export interface StoredCredentials {
  // Parent session (from initial login, used to fork new child sessions)
  parentUID: string;
  parentAccessToken: string;
  parentRefreshToken: string;

  // Child session (used for API operations, can be refreshed via forking)
  childUID: string;
  childAccessToken: string;
  childRefreshToken: string;

  // Shared credentials
  SaltedKeyPass: string;
  UserID: string;
  username: string;

  // Password mode: 1 = Single, 2 = Two-password mode
  passwordMode: PasswordMode;
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    // Try native keychain first if available
    if (shouldUseNativeKeychain()) {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      const data = entry.getPassword();
      if (!data) return null;
      return JSON.parse(data) as StoredCredentials;
    }

    // Fallback to file-based storage
    return getCredentialsFromFile(getKeyringPassword()) as StoredCredentials | null;
  } catch (error) {
    logger.debug(`Failed to get stored credentials: ${error}`);
    return null;
  }
}

export async function storeCredentials(credentials: StoredCredentials): Promise<void> {
  try {
    // Try native keychain first if available
    if (shouldUseNativeKeychain()) {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      entry.setPassword(JSON.stringify(credentials));
      logger.debug('Credentials stored in native keychain');
      return;
    }
  } catch (error) {
    logger.warn(`Failed to store credentials in native keychain: ${error}`);
    logger.info('Falling back to file-based storage');
  }

  // Fallback to file-based storage
  storeCredentialsToFile(credentials, getKeyringPassword());
  logger.debug('Credentials stored in encrypted file');
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    // Try native keychain first if available
    if (shouldUseNativeKeychain()) {
      const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      entry.deleteCredential();
      logger.debug('Credentials deleted from native keychain');
    }
  } catch (error) {
    logger.debug(`No credentials in native keychain to delete: ${error}`);
  }

  try {
    // Also clean up file-based storage (in case of migration or fallback)
    deleteCredentialsFile();
  } catch (error) {
    logger.debug(`No credentials file to delete: ${error}`);
  }
}
