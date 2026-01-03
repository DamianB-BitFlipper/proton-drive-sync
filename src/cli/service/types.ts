/**
 * Shared types for platform-specific service implementations
 */

export const SERVICE_NAME = 'proton-drive-sync';

export type InstallScope = 'user' | 'system';

export interface ServiceResult {
  success: boolean;
  error?: string;
}

export interface ServiceOperations {
  /** Install the service (create config files) */
  install(binPath: string, keyringPassword?: string): Promise<boolean>;

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
