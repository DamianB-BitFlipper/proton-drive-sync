export function isTwoWaySyncEnabled(syncDir: { two_way?: boolean }): boolean {
  return syncDir.two_way === true;
}
