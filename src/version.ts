// The version this copy of minitart is. The source says 0.0.0, which is never published:
// a release writes the real one into a VERSION file beside package.json (docs/release.md).

import { readFileSync } from 'node:fs';

/** What a checkout of the source calls itself. */
export const DEVELOPMENT = '0.0.0-dev';

export function readVersion(file: URL = new URL('../VERSION', import.meta.url)): string {
  try {
    const version = readFileSync(file, 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : DEVELOPMENT;
  } catch {
    return DEVELOPMENT;
  }
}

export const VERSION = readVersion();
