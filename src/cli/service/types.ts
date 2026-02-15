/**
 * Shared types for platform-specific service implementations
 */

export const SERVICE_NAME = 'proton-drive-sync';

export type InstallScope = 'user' | 'system';

import type { KeychainBackend } from '../../keychain-backends.js';
export type { KeychainBackend } from '../../keychain-backends.js';

export interface ServiceInstallOptions {
  /**
   * Preferred keychain backend for the service runtime.
   * "file" forces encrypted file-based storage (useful for headless/system boot),
   * "native" prefers OS keyring, and "auto" tries native then falls back to file.
   */
  keychainBackend?: KeychainBackend;
}

export interface ServiceResult {
  success: boolean;
  error?: string;
}

export interface ServiceOperations {
  /** Install the service (create config files) */
  install(binPath: string, options?: ServiceInstallOptions): Promise<boolean>;

  /** Uninstall the service (remove config files) */
  uninstall(interactive: boolean): Promise<boolean>;

  /** Load/enable the service (start on login) */
  load(): boolean;

  /** Unload/disable the service (stop starting on login) */
  unload(): boolean;

  /** Check if service is installed */
  isInstalled(): boolean;

  /** Get the service configuration file path */
  getServicePath(): string;
}
