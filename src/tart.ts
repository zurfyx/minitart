// The `tart` command line, and nothing more. Isolation is Tart's and Apple's hypervisor's
// job (D01); this file only makes sure a VM is started the isolated way: no shared folders,
// no clipboard, and a network that reaches the internet and nothing private (D04).

import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `softnet`: internet only. `shared`: Tart's default NAT, which reaches the LAN. Unsafe. */
export type Network = 'softnet' | 'shared';

export interface TartVm {
  name: string;
  running: boolean;
  /** `local` for a VM on this Mac, `OCI` for a pulled image. */
  source: string;
}

export interface ExecOptions {
  /** Sent to the command's standard input, which is then closed. */
  stdin?: string;
  onLine?: (line: string) => void;
  /** The command is killed, and the exit code is 124, if it runs longer than this. */
  timeoutMs?: number;
}

export interface Tart {
  /**
   * Every VM and image. Used sparingly: on macOS 27 each `tart list` leaks kernel memory,
   * and one that lands just after `tart run` can make that boot fail.
   */
  list(): Promise<TartVm[]>;
  /** Whether a VM or image of this name exists, without listing. */
  has(name: string): Promise<boolean>;
  /** Grows the VM's disk. The guest grows its filesystem on boot. */
  resize(name: string, diskGb: number): Promise<void>;
  /** Downloads an image from a registry. Slow: a macOS image is tens of gigabytes. */
  pull(source: string, onLine: (line: string) => void): Promise<void>;
  clone(source: string, name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  configure(name: string, size: { cpu: number; memoryMb: number }): Promise<void>;
  /** Starts the VM. The promise settles when the VM is no longer running. */
  boot(name: string, network: Network, onLine: (line: string) => void): Promise<void>;
  /** Runs a command in the guest and resolves with its exit code. */
  exec(name: string, command: readonly string[], options?: ExecOptions): Promise<number>;
  stop(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Softnet lets a VM send only to public internet addresses and to its gateway, so the LAN
 * and anything else private are out of reach without being listed. 100.64.0.0/10 is named
 * because it is the range Tailscale uses and "globally routable" is Softnet's call to make.
 */
export function networkArgs(network: Network): string[] {
  return network === 'softnet' ? ['--net-softnet', '--net-softnet-block=100.64.0.0/10'] : [];
}

/** No line of a VM's output is kept longer than this. */
const MAX_LINE = 4096;

/** `tart list` answers in well under a second; past this it is not going to. */
const LIST_TIMEOUT_MS = 60_000;

/** Calls `onLine` for each complete line of what a stream emits. */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  end(): void;
} {
  let rest = '';
  return {
    push(chunk) {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const line of lines) onLine(line.slice(0, MAX_LINE));
      // Output with no newline in it is cut into lines rather than held without end.
      while (rest.length > MAX_LINE) {
        onLine(rest.slice(0, MAX_LINE));
        rest = rest.slice(MAX_LINE);
      }
    },
    end() {
      if (rest !== '') onLine(rest);
      rest = '';
    },
  };
}

/** A splitter each for stdout and stderr, so half a line of one never joins the other's. */
function streams(onLine: (line: string) => void) {
  const out = lineSplitter(onLine);
  const err = lineSplitter(onLine);
  return {
    out,
    err,
    end() {
      out.end();
      err.end();
    },
  };
}

export class TartCli implements Tart {
  readonly #bin: string;

  constructor(bin = 'tart') {
    this.#bin = bin;
  }

  async list(): Promise<TartVm[]> {
    // One that hangs must fail instead: the manager waits for this before it polls again.
    const rows = JSON.parse(await this.#run(['list', '--format', 'json'], LIST_TIMEOUT_MS)) as {
      Name: string;
      Running: boolean;
      Source: string;
    }[];
    return rows.map((row) => ({ name: row.Name, running: row.Running, source: row.Source }));
  }

  async has(name: string): Promise<boolean> {
    // A registry image is stored under a name only Tart knows how to map.
    if (/[/:@]/.test(name)) return (await this.list()).some((vm) => vm.name === name);
    const home = process.env['TART_HOME'] ?? join(homedir(), '.tart');
    try {
      await stat(join(home, 'vms', name, 'config.json'));
      return true;
    } catch {
      return false;
    }
  }

  async resize(name: string, diskGb: number): Promise<void> {
    await this.#run(['set', name, '--disk-size', String(diskGb)]);
  }

  pull(source: string, onLine: (line: string) => void): Promise<void> {
    const child = spawn(this.#bin, ['pull', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = streams(onLine);
    child.stdout.setEncoding('utf8').on('data', lines.out.push);
    child.stderr.setEncoding('utf8').on('data', lines.err.push);
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => {
        lines.end();
        if (code === 0) resolve();
        else reject(new Error(`tart pull ${source} exited with code ${code}`));
      });
    });
  }

  async clone(source: string, name: string): Promise<void> {
    await this.#run(['clone', source, name]);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#run(['rename', from, to]);
  }

  async configure(name: string, size: { cpu: number; memoryMb: number }): Promise<void> {
    await this.#run(['set', name, '--cpu', String(size.cpu), '--memory', String(size.memoryMb)]);
  }

  boot(name: string, network: Network, onLine: (line: string) => void): Promise<void> {
    const child = spawn(
      this.#bin,
      ['run', name, '--no-graphics', '--no-audio', '--no-clipboard', ...networkArgs(network)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = streams(onLine);
    child.stdout.setEncoding('utf8').on('data', lines.out.push);
    child.stderr.setEncoding('utf8').on('data', lines.err.push);
    return new Promise((resolve) => {
      child.on('error', (error) => {
        onLine(`tart run: ${error.message}`);
        resolve();
      });
      child.on('close', () => {
        lines.end();
        resolve();
      });
    });
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    const stdin = options.stdin;
    const child = spawn(
      this.#bin,
      ['exec', ...(stdin === undefined ? [] : ['-i']), name, ...command],
      { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
    );
    const lines = streams(options.onLine ?? (() => {}));
    child.stdout?.setEncoding('utf8').on('data', lines.out.push);
    child.stderr?.setEncoding('utf8').on('data', lines.err.push);
    if (stdin !== undefined && child.stdin) {
      // The guest may be gone before it reads; the exit code already says so.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs);
    return new Promise((resolve) => {
      child.on('error', () => resolve(127));
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        lines.end();
        resolve(timedOut ? 124 : (code ?? 1));
      });
    });
  }

  async stop(name: string): Promise<void> {
    await this.#run(['stop', name, '--timeout', '10']);
  }

  async remove(name: string): Promise<void> {
    await this.#run(['delete', name]);
  }

  #run(args: string[], timeoutMs = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      const options = { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs };
      execFile(this.#bin, args, options, (error, stdout, stderr) => {
        if (error) {
          const detail = error.killed ? 'no answer in time' : stderr.trim() || error.message;
          reject(new Error(`tart ${args[0]}: ${detail}`));
        } else resolve(stdout);
      });
    });
  }
}
