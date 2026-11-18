// `minitart upgrade`: a new minitart without losing a job, and with the Mac's password asked
// for once, at the moment it is needed (D16).
//
// The order matters. Jobs finish first (drain). Then the software changes. Then whatever the
// change undid as root is put back (`doctor --fix`: a new Softnet binary has lost its
// permission). Then minitart starts again.

/** How this copy of minitart got onto the Mac. */
export type Install =
  | { kind: 'brew'; prefix: string }
  /** A checkout of the source, run where it stands. */
  | { kind: 'git'; root: string };

/** Where `main.ts` lives says which: Homebrew keeps it under a `Cellar/minitart` folder. */
export function installKind(mainPath: string): Install {
  const cellar = /^(.*)\/Cellar\/minitart\/[^/]+\/libexec\/src\/main\.ts$/.exec(mainPath);
  if (cellar?.[1] !== undefined) return { kind: 'brew', prefix: cellar[1] };
  return { kind: 'git', root: mainPath.replace(/\/src\/main\.ts$/, '') };
}

export interface Step {
  what: string;
  command: string[];
  /** A step that may fail without stopping the upgrade (a formula that is not pinned). */
  optional?: boolean;
}

/**
 * The commands of an upgrade, after the drain. `ownService` is whether minitart runs as the
 * LaunchAgent that `minitart service install` wrote, rather than as a Homebrew service.
 */
export function upgradeSteps(
  install: Install,
  options: { node: string; ownService: boolean; serviceArgs: readonly string[] },
): Step[] {
  if (install.kind === 'git') {
    const main = `${install.root}/src/main.ts`;
    return [
      { what: 'Getting the new source', command: ['git', '-C', install.root, 'pull', '--ff-only'] },
      // The new doctor, not this one: it knows what the new version needs.
      {
        what: 'Putting right what needs the password',
        command: [options.node, main, 'doctor', '--fix'],
      },
      {
        what: 'Starting minitart again',
        command: [options.node, main, 'service', 'install', ...options.serviceArgs],
      },
    ];
  }
  const brew = `${install.prefix}/bin/brew`;
  const minitart = `${install.prefix}/bin/minitart`;
  return [
    { what: 'Asking Homebrew what is new', command: [brew, 'update', '--quiet'] },
    // Softnet is kept pinned, so that only this command replaces its binary, which costs it
    // its permission: Tart, minitart and Softnet change together, and are put right together.
    { what: 'Unpinning Softnet', command: [brew, 'unpin', 'softnet'], optional: true },
    {
      what: 'Upgrading minitart, Tart and Softnet',
      command: [
        brew,
        'upgrade',
        'zurfyx/tap/minitart',
        'openai/tools/tart',
        'openai/tools/softnet',
      ],
    },
    { what: 'Pinning Softnet', command: [brew, 'pin', 'softnet'], optional: true },
    { what: 'Putting right what needs the password', command: [minitart, 'doctor', '--fix'] },
    options.ownService
      ? {
          what: 'Starting minitart again',
          command: [minitart, 'service', 'install', ...options.serviceArgs],
        }
      : {
          what: 'Starting minitart again',
          command: [brew, 'services', 'restart', 'zurfyx/tap/minitart'],
        },
  ];
}

/** Talks to the minitart that is running on this Mac, if one is. */
export class Running {
  readonly #origin: string;

  constructor(port: number) {
    this.#origin = `http://127.0.0.1:${port}`;
  }

  /** How many VMs it has, or `null` when nothing answers. */
  async vms(): Promise<number | null> {
    try {
      const response = await fetch(`${this.#origin}/api/state`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      return ((await response.json()) as { vms: unknown[] }).vms.length;
    } catch {
      return null;
    }
  }

  async drain(draining: boolean): Promise<boolean> {
    try {
      const response = await fetch(`${this.#origin}/api/drain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: this.#origin },
        body: JSON.stringify({ draining }),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Drains, and resolves once no VM is left. `false` when no minitart is running. */
  async drained(
    print: (line: string) => void,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<boolean> {
    if (!(await this.drain(true))) return false;
    let said = -1;
    for (;;) {
      const vms = await this.vms();
      if (vms === null || vms === 0) return vms === 0;
      if (vms !== said) print(`Waiting for ${vms} VM${vms === 1 ? '' : 's'} to finish its job`);
      said = vms;
      await sleep(5000);
    }
  }
}
