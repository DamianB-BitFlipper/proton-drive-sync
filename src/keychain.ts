/**
 * Keychain utilities for storing and retrieving Proton credentials
 *
 * Cross-platform secure credential storage:
 * - macOS: Keychain (via keytar)
 * - Windows: Credential Manager (via keytar)
 * - Linux with KEYRING_PASSWORD: File-based encrypted storage (for headless servers)
 * - Linux without KEYRING_PASSWORD: libsecret via keytar (for desktop environments)
 */

import { logger } from './logger.js';
import type { PasswordMode } from './auth.js';
import {
  storeCredentialsToFile,
  getCredentialsFromFile,
  deleteCredentialsFile,
} from './keychain-file.js';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT = 'proton-drive-sync:tokens';
const DEFAULT_KEYRING_PASSWORD = 'proton-drive-sync';

/**
 * Check if we should use file-based storage.
 * On Linux, always use file-based encrypted storage (avoids libsecret/gnome-keyring complexity).
 * On macOS/Windows, use keytar (Keychain/Credential Manager).
 */
function useFileStorage(): boolean {
  return process.platform === 'linux';
}

/**
 * Dynamically import keytar to avoid loading libsecret on Linux when it's not needed.
 */
async function getKeytar() {
  return (await import('keytar')).default;
}

/**
 * Get the keyring password for file-based storage.
 * Uses KEYRING_PASSWORD env var if set, otherwise falls back to default.
 */
function getKeyringPassword(): string {
  return process.env.KEYRING_PASSWORD || DEFAULT_KEYRING_PASSWORD;
}

/** Tokens stored in keychain for session reuse (single session model) */
export interface StoredCredentials {
  // Session tokens
  UID: string;
  AccessToken: string;
  RefreshToken: string;

  // Credentials
  SaltedKeyPass: string;
  UserID: string;
  username: string;

  // Password mode: 1 = Single, 2 = Two-password mode
  passwordMode: PasswordMode;
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    // Linux: use file-based storage
    if (useFileStorage()) {
      return getCredentialsFromFile(getKeyringPassword()) as StoredCredentials | null;
    }

    // macOS/Windows/Linux desktop: use keytar
    const keytar = await getKeytar();
    const data = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!data) return null;
    return JSON.parse(data) as StoredCredentials;
  } catch (error) {
    logger.debug(`Failed to get stored credentials: ${error}`);
    return null;
  }
}

export async function storeCredentials(credentials: StoredCredentials): Promise<void> {
  // Linux: use file-based storage
  if (useFileStorage()) {
    storeCredentialsToFile(credentials, getKeyringPassword());
    return;
  }

  // macOS/Windows/Linux desktop: use keytar
  const keytar = await getKeytar();
  await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(credentials));
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    // Linux: use file-based storage
    if (useFileStorage()) {
      deleteCredentialsFile();
      return;
    }

    // macOS/Windows/Linux desktop: use keytar
    const keytar = await getKeytar();
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    // Ignore - may not exist
  }
}
