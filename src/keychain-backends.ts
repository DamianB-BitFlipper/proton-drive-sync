export const KeychainBackends = {
  AUTO: 'auto',
  NATIVE: 'native',
  FILE: 'file',
} as const;

export type KeychainBackend = (typeof KeychainBackends)[keyof typeof KeychainBackends];
