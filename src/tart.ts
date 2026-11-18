// The `tart` command line, and nothing more. Isolation is Tart's and Apple's hypervisor's
// job (D01); this file only makes sure a VM is started the isolated way: no shared folders,
// no clipboard, and a network that reaches the internet and nothing private (D04).

import { execFile, spawn } from 'node:child_process';

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
}

export interface Tart {
  list(): Promise<TartVm[]>;
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
      for (const line of lines) onLine(line);
    },
    end() {
      if (rest !== '') onLine(rest);
      rest = '';
    },
  };
}

export class TartCli implements Tart {
  readonly #bin: string;

  constructor(bin = 'tart') {
    this.#bin = bin;
  }

  async list(): Promise<TartVm[]> {
    const rows = JSON.parse(await this.#run(['list', '--format', 'json'])) as {
      Name: string;
      Running: boolean;
      Source: string;
    }[];
    return rows.map((row) => ({ name: row.Name, running: row.Running, source: row.Source }));
  }

  pull(source: string, onLine: (line: string) => void): Promise<void> {
    const child = spawn(this.#bin, ['pull', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = lineSplitter(onLine);
    child.stdout.setEncoding('utf8').on('data', lines.push);
    child.stderr.setEncoding('utf8').on('data', lines.push);
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
    const lines = lineSplitter(onLine);
    child.stdout.setEncoding('utf8').on('data', lines.push);
    child.stderr.setEncoding('utf8').on('data', lines.push);
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
    const lines = lineSplitter(options.onLine ?? (() => {}));
    child.stdout?.setEncoding('utf8').on('data', lines.push);
    child.stderr?.setEncoding('utf8').on('data', lines.push);
    if (stdin !== undefined && child.stdin) {
      // The guest may be gone before it reads; the exit code already says so.
      child.stdin.on('error', () => {});
      child.stdin.end(stdin);
    }
    return new Promise((resolve) => {
      child.on('error', () => resolve(127));
      child.on('close', (code) => {
        lines.end();
        resolve(code ?? 1);
      });
    });
  }

  async stop(name: string): Promise<void> {
    await this.#run(['stop', name, '--timeout', '10']);
  }

  async remove(name: string): Promise<void> {
    await this.#run(['delete', name]);
  }

  #run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.#bin, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(`tart ${args[0]}: ${detail}`));
        } else resolve(stdout);
      });
    });
  }
}
