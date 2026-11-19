// ~/.minitart: the App's key, the saved settings, the job history (history.ts) and the logs. Everything
// in it is written for the owner only (0600), the key above all.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const VM_LOG = /^minitart-(linux|macos)-[0-9a-f]{6}\.log$/;

export class Home {
  readonly dir: string;

  constructor(dir = process.env['MINITART_HOME'] ?? join(homedir(), '.minitart')) {
    this.dir = dir;
    mkdirSync(join(dir, 'logs'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  path(...parts: string[]): string {
    return join(this.dir, ...parts);
  }

  /** The parsed file, or `undefined` when it does not exist. A file that is not JSON throws. */
  readJson(name: string): unknown {
    let text: string;
    try {
      text = readFileSync(this.path(name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    return JSON.parse(text);
  }

  /** Written beside the file and renamed over it, so a crash never leaves half a file. */
  writeJson(name: string, value: unknown): void {
    const target = this.path(name);
    const temp = `${target}.${process.pid}.tmp`;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, target);
  }

  /** Moves a file aside under a new name, replacing what was there. Resolves with the new path. */
  setAside(name: string, as: string): string {
    renameSync(this.path(name), this.path(as));
    return this.path(as);
  }

  /** A log line that cannot be written (a full disk) is dropped, not thrown. */
  appendLog(name: string, line: string): void {
    try {
      appendFileSync(this.path('logs', name), `${line}\n`, { mode: 0o600 });
    } catch {
      // The log is a convenience; the manager keeps running without it.
    }
  }

  /** A VM's log as written, its last `maxBytes`; null when there is none. */
  readLog(name: string, maxBytes: number): string | null {
    try {
      const text = readFileSync(this.path('logs', name), 'utf8');
      return text.length > maxBytes ? text.slice(-maxBytes) : text;
    } catch {
      return null;
    }
  }

  /** How many VM logs there are, and what they take. minitart's own log is not one. */
  logsUsage(): { files: number; bytes: number } {
    try {
      const dir = this.path('logs');
      const names = readdirSync(dir).filter((name) => VM_LOG.test(name));
      let bytes = 0;
      for (const name of names) bytes += statSync(join(dir, name)).size;
      return { files: names.length, bytes };
    } catch {
      return { files: 0, bytes: 0 };
    }
  }

  /** Deletes all but the newest `keep` VM logs. The logs of live VMs (`skip`) always stay. */
  pruneLogs(keep: number, skip: ReadonlySet<string> = new Set()): void {
    try {
      const dir = this.path('logs');
      const logs = readdirSync(dir)
        .filter((name) => VM_LOG.test(name) && !skip.has(name))
        .map((name) => ({ name, modified: statSync(join(dir, name)).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      for (const log of logs.slice(keep)) rmSync(join(dir, log.name), { force: true });
    } catch {
      // Tried again in a minute.
    }
  }
}
