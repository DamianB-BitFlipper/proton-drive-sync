/**
 * Keychain utilities for storing and retrieving Proton credentials
 *
 * Uses keytar for cross-platform secure credential storage:
 * - macOS: Keychain
 * - Linux: libsecret (GNOME Keyring, KWallet, etc.)
 */

import keytar from 'keytar';
import { logger } from './logger.js';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT = 'proton-drive-sync:tokens';

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

  // Password mode: 1 = Single, 2 = Dual (two-password mode)
  passwordMode: number;
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    const data = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    if (!data) return null;
    return JSON.parse(data) as StoredCredentials;
  } catch (error) {
    logger.debug(`Failed to get stored credentials: ${error}`);
    return null;
  }
}

export async function storeCredentials(credentials: StoredCredentials): Promise<void> {
  await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, JSON.stringify(credentials));
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    // Ignore - may not exist
  }
}
