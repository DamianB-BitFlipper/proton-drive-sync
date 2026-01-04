/**
 * Keychain utilities for storing and retrieving Proton credentials
 *
 * Cross-platform secure credential storage:
 * - macOS: Keychain (via keytar)
 * - Windows: Credential Manager (via keytar)
 * - Linux with KEYRING_PASSWORD: File-based encrypted storage (for headless servers)
 * - Linux without KEYRING_PASSWORD: libsecret via keytar (for desktop environments)
 */

import keytar from 'keytar';
import { logger } from './logger.js';
import type { PasswordMode } from './auth.js';
import {
  storeCredentialsToFile,
  getCredentialsFromFile,
  deleteCredentialsFile,
} from './keychain-file.js';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT = 'proton-drive-sync:tokens';

/**
 * Check if we should use file-based storage.
 * On Linux, use file storage when KEYRING_PASSWORD env var is set (headless/service mode).
 * Otherwise, use keytar (macOS Keychain, Windows Credential Manager, Linux libsecret).
 */
function useFileStorage(): boolean {
  return process.platform === 'linux' && !!process.env.KEYRING_PASSWORD;
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
    // Linux with KEYRING_PASSWORD: use file-based storage
    if (useFileStorage()) {
      const password = process.env.KEYRING_PASSWORD!;
      return getCredentialsFromFile(password) as StoredCredentials | null;
    }

    // macOS/Windows/Linux desktop: use keytar
    const data = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!data) return null;
    return JSON.parse(data) as StoredCredentials;
  } catch (error) {
    logger.debug(`Failed to get stored credentials: ${error}`);
    return null;
  }
}

export async function storeCredentials(credentials: StoredCredentials): Promise<void> {
  // Linux with KEYRING_PASSWORD: use file-based storage
  if (useFileStorage()) {
    const password = process.env.KEYRING_PASSWORD!;
    storeCredentialsToFile(credentials, password);
    return;
  }

  // macOS/Windows/Linux desktop: use keytar
  await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(credentials));
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    // Linux with KEYRING_PASSWORD: use file-based storage
    if (useFileStorage()) {
      deleteCredentialsFile();
      return;
    }

    // macOS/Windows/Linux desktop: use keytar
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    // Ignore - may not exist
  }
}
