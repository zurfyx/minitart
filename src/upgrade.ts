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
  /**
   * A step whose failure does not stop the upgrade: a formula that is not pinned or not
   * installed, and doctor, which also fails for things an upgrade has nothing to do with.
   */
  optional?: boolean;
}

/**
 * How the minitart that runs on this Mac is kept running: the LaunchAgent that
 * `minitart service install` wrote, Homebrew's service, or neither (someone started it in a
 * terminal, and will start it again themselves).
 */
export type Service = 'own' | 'brew' | 'none';

/** The flags a LaunchAgent written by `service install` starts minitart with. */
export function serviceArgs(plist: string): string[] {
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1] ?? '');
  const start = strings.indexOf('start');
  if (start === -1) return [];
  const args: string[] = [];
  for (const value of strings.slice(start + 1)) {
    // The arguments end where the next key's values begin; flags and their numbers only.
    if (!/^(--[a-z-]+|\d+)$/.test(value)) break;
    args.push(value);
  }
  return args;
}

/** The commands of an upgrade, after the drain. */
export function upgradeSteps(
  install: Install,
  options: { node: string; service: Service; serviceArgs: readonly string[] },
): Step[] {
  const restart = (minitart: string[], brew?: string): Step[] => {
    if (options.service === 'own') {
      return [
        {
          what: 'Starting minitart again',
          command: [...minitart, 'service', 'install', ...options.serviceArgs],
        },
      ];
    }
    if (options.service === 'brew' && brew !== undefined) {
      return [
        {
          what: 'Starting minitart again',
          command: [brew, 'services', 'restart', 'zurfyx/tap/minitart'],
        },
      ];
    }
    // Nothing keeps it running, so nothing is started behind the owner's back.
    return [];
  };
  // The new doctor, not this one: it knows what the new version needs. It comes before the
  // restart, since a minitart restarted before Softnet has its permission back starts no VM;
  // and it never stops the upgrade, since it also fails for things that have nothing to do
  // with one (a full disk), and those must not leave minitart stopped.
  const doctor = (minitart: string[]): Step => ({
    what: 'Putting right what needs the password',
    command: [...minitart, 'doctor', '--fix'],
    optional: true,
  });

  if (install.kind === 'git') {
    const minitart = [options.node, `${install.root}/src/main.ts`];
    return [
      { what: 'Getting the new source', command: ['git', '-C', install.root, 'pull', '--ff-only'] },
      doctor(minitart),
      ...restart(minitart),
    ];
  }
  const brew = `${install.prefix}/bin/brew`;
  const minitart = [`${install.prefix}/bin/minitart`];
  return [
    { what: 'Asking Homebrew what is new', command: [brew, 'update', '--quiet'] },
    { what: 'Upgrading minitart', command: [brew, 'upgrade', 'zurfyx/tap/minitart'] },
    // Tart and Softnet change with it, and are put right with it. Softnet is kept pinned, so
    // that only this command replaces its binary, which costs it its permission. Each on its
    // own line: one that is not installed fails alone.
    { what: 'Upgrading Tart', command: [brew, 'upgrade', 'openai/tools/tart'], optional: true },
    { what: 'Unpinning Softnet', command: [brew, 'unpin', 'softnet'], optional: true },
    {
      what: 'Upgrading Softnet',
      command: [brew, 'upgrade', 'openai/tools/softnet'],
      optional: true,
    },
    { what: 'Pinning Softnet', command: [brew, 'pin', 'softnet'], optional: true },
    doctor(minitart),
    ...restart(minitart, brew),
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
    let silent = 0;
    for (;;) {
      const vms = await this.vms();
      if (vms === 0) return true;
      if (vms === null) {
        // One answer missed is not a minitart that has gone: its jobs may still be running.
        if (++silent >= 3) return false;
        await sleep(2000);
        continue;
      }
      silent = 0;
      if (vms !== said) print(`Waiting for ${vms} VM${vms === 1 ? '' : 's'} to finish its job`);
      said = vms;
      await sleep(5000);
    }
  }
}
