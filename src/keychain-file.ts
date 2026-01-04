/**
 * File-based encrypted credential storage for Linux headless environments
 *
 * Uses AES-256-GCM encryption with password-derived key (PBKDF2).
 * This avoids the complexity of gnome-keyring/libsecret in headless server environments.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from './logger.js';

const CREDENTIALS_FILENAME = 'credentials.enc';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 32;
const TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;

/**
 * Get the path to the encrypted credentials file based on scope.
 * System scope: /etc/proton-drive-sync/credentials.enc
 * User scope: ~/.config/proton-drive-sync/credentials.enc
 */
function getCredentialsPath(): string {
  // Check if system scope by looking for the system config directory
  const systemPath = '/etc/proton-drive-sync';
  if (existsSync(systemPath)) {
    return join(systemPath, CREDENTIALS_FILENAME);
  }

  // Default to user scope
  const home = process.env.HOME || '/root';
  return join(home, '.config', 'proton-drive-sync', CREDENTIALS_FILENAME);
}

/**
 * Derive an encryption key from password using PBKDF2
 */
function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt data using AES-256-GCM
 * Returns: salt (32) + iv (16) + authTag (16) + encryptedData
 */
export function encryptCredentials(data: string, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: salt (32) + iv (16) + tag (16) + encrypted data
  return Buffer.concat([salt, iv, tag, encrypted]);
}

/**
 * Decrypt data using AES-256-GCM
 * Expects format: salt (32) + iv (16) + authTag (16) + encryptedData
 */
export function decryptCredentials(data: Buffer, password: string): string {
  const salt = data.subarray(0, SALT_LENGTH);
  const iv = data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = data.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

/**
 * Store credentials to an encrypted file
 */
export function storeCredentialsToFile(credentials: object, password: string): void {
  const path = getCredentialsPath();
  const dir = dirname(path);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const encrypted = encryptCredentials(JSON.stringify(credentials), password);
  writeFileSync(path, encrypted, { mode: 0o600 }); // rw------- (owner only)
  logger.debug(`Credentials stored to ${path}`);
}

/**
 * Get credentials from encrypted file
 * Returns null if file doesn't exist or decryption fails
 */
export function getCredentialsFromFile(password: string): object | null {
  const path = getCredentialsPath();

  if (!existsSync(path)) {
    logger.debug(`Credentials file not found: ${path}`);
    return null;
  }

  try {
    const encrypted = readFileSync(path);
    const decrypted = decryptCredentials(encrypted, password);
    return JSON.parse(decrypted);
  } catch (error) {
    logger.debug(`Failed to decrypt credentials: ${error}`);
    return null;
  }
}

/**
 * Delete the encrypted credentials file
 */
export function deleteCredentialsFile(): void {
  const path = getCredentialsPath();

  if (existsSync(path)) {
    unlinkSync(path);
    logger.debug(`Deleted credentials file: ${path}`);
  }
}
