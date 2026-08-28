import { describe, expect, test } from 'bun:test';
import { isTwoWaySyncEnabled } from './syncDirection.js';

describe('isTwoWaySyncEnabled', () => {
  test('keeps folders backup-only by default', () => {
    expect(isTwoWaySyncEnabled({ two_way: false })).toBe(false);
  });

  test('enables remote synchronization explicitly', () => {
    expect(isTwoWaySyncEnabled({ two_way: true })).toBe(true);
  });

  test('treats missing legacy settings as backup-only', () => {
    expect(isTwoWaySyncEnabled({})).toBe(false);
  });
});
