/**
 * File Exclusion System
 *
 * Provides glob pattern matching to exclude files/directories from sync.
 * Supports simple globs: * (any chars except /), ** (any path), ? (single char)
 */

import { relative } from 'path';

import type { ExcludePattern } from '../config.js';

// ============================================================================
// Always-Excluded Paths
// ============================================================================

/**
 * Temp/working artifacts created by this app itself while downloading or
 * merging files. These must never be synced regardless of user config, and
 * may briefly appear inside a synced directory during processing.
 */
const INTERNAL_TEMP_PATTERNS: RegExp[] = [
  /\.proton-download-.*\.tmp$/,
  /\.proton-remote-.*\.tmp$/,
  /\.proton-merged-.*\.tmp$/,
  /(^|\/)\.odt-merge-[^/]*(\/|$)/, // legacy merge working dirs from older versions
];

/**
 * Lock/autosave files created by common office suites on the *other* machine
 * while a document is open. These are ephemeral, machine-local, and syncing
 * them causes false conflicts (created/deleted rapidly, never meant to be
 * shared). Excluded unconditionally, independent of user exclude_patterns.
 */
const THIRD_PARTY_LOCK_PATTERNS: RegExp[] = [
  /(^|\/)\.~lock\..*#$/, // LibreOffice lock files, e.g. .~lock.report.odt#
  /(^|\/)~\$.*$/, // Microsoft Office lock files, e.g. ~$report.docx
];

/**
 * Check if a path is an internal sync artifact (our own temp files/dirs).
 */
export function isInternalTempPath(absolutePath: string): boolean {
  return INTERNAL_TEMP_PATTERNS.some((pattern) => pattern.test(absolutePath));
}

/**
 * Check if a path matches a well-known third-party lock/autosave file that
 * should never be synced.
 */
function isThirdPartyLockFile(relativePath: string): boolean {
  return THIRD_PARTY_LOCK_PATTERNS.some((pattern) => pattern.test(relativePath));
}

// ============================================================================
// Glob to Regex Conversion
// ============================================================================

/**
 * Escape special regex characters except glob wildcards
 */
function escapeRegexChars(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a simple glob pattern to a regex.
 *
 * Supported patterns:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/` (any path depth)
 * - `?` matches a single character except `/`
 * - Literal characters are escaped
 *
 * The pattern matches against any segment of the path, so `node_modules`
 * will match `node_modules/foo`, `bar/node_modules/baz`, etc.
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex special chars first (except * and ?)
  let regexStr = escapeRegexChars(pattern);

  // Replace glob patterns with regex equivalents
  // Must handle ** before * to avoid double replacement
  regexStr = regexStr
    .replace(/\*\*/g, '{{GLOBSTAR}}') // Temporary placeholder
    .replace(/\*/g, '[^/]*') // * matches anything except /
    .replace(/\?/g, '[^/]') // ? matches single char except /
    .replace(/{{GLOBSTAR}}/g, '.*'); // ** matches anything including /

  // Match pattern anywhere in the path (as a complete segment or prefix)
  // This makes `node_modules` match `node_modules`, `node_modules/foo`,
  // `bar/node_modules`, `bar/node_modules/baz`, etc.
  return new RegExp(`(^|/)${regexStr}($|/)`);
}

// ============================================================================
// Pattern Validation
// ============================================================================

/**
 * Validate that a glob pattern is syntactically correct.
 * Returns an object with valid boolean and optional error message.
 */
export function validateGlob(pattern: string): { valid: boolean; error?: string } {
  if (!pattern || pattern.trim() === '') {
    return { valid: false, error: 'Pattern cannot be empty' };
  }

  if (pattern.startsWith('/')) {
    return { valid: false, error: 'Pattern cannot start with / (use relative patterns)' };
  }

  // Check for invalid sequences
  if (pattern.includes('***')) {
    return { valid: false, error: 'Invalid pattern: *** is not allowed' };
  }

  // Try to compile the regex to catch any other issues
  try {
    globToRegex(pattern);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// Path Exclusion Check
// ============================================================================

/** Cache compiled regexes for performance */
const regexCache = new Map<string, RegExp>();

/**
 * Get or create a cached regex for a glob pattern
 */
function getCachedRegex(pattern: string): RegExp {
  let regex = regexCache.get(pattern);
  if (!regex) {
    regex = globToRegex(pattern);
    regexCache.set(pattern, regex);
  }
  return regex;
}

/**
 * Check if a path should be excluded from sync.
 *
 * @param absolutePath - Full absolute path to the file/directory
 * @param syncDirPath - The sync_dir source_path this file belongs to
 * @param excludePatterns - All exclude patterns from config
 * @returns true if the path should be excluded
 */
export function isPathExcluded(
  absolutePath: string,
  syncDirPath: string,
  excludePatterns: ExcludePattern[]
): boolean {
  if (isInternalTempPath(absolutePath)) {
    return true;
  }

  // Compute relative path from sync dir
  const relativePath = relative(syncDirPath, absolutePath);
  if (!relativePath) {
    // Path is the sync dir itself, don't exclude
    return false;
  }

  if (isThirdPartyLockFile(relativePath)) {
    return true;
  }

  if (!excludePatterns || excludePatterns.length === 0) {
    return false;
  }

  // Check each exclude pattern entry
  for (const entry of excludePatterns) {
    // Check if this entry applies to the current path
    // "/" applies to all paths, otherwise check if absolutePath is under entry.path
    const applies =
      entry.path === '/' ||
      absolutePath.startsWith(entry.path + '/') ||
      absolutePath === entry.path;

    if (!applies) {
      continue;
    }

    // Check each glob in this entry
    for (const glob of entry.globs) {
      const regex = getCachedRegex(glob);
      if (regex.test(relativePath)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Clear the regex cache (useful for config reload)
 */
export function clearRegexCache(): void {
  regexCache.clear();
}
