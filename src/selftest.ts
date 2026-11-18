// `minitart selftest`: boots a throwaway Linux VM the way a job VM boots and checks, from
// inside it, what it can reach. The promise under test is D04: the internet, and nothing of
// yours. Run it after setting up, and again after changing how this Mac is networked.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { guestShell } from './manager.ts';
import type { Network, Tart } from './tart.ts';

export interface Probe {
  what: string;
  /**
   * An HTTPS URL to fetch, a TCP port of some address, or a TCP port of the VM's own
   * gateway, which is this Mac and which only the VM knows the address of.
   */
  target: { url: string } | { host: string; port: number } | { gateway: number };
  /**
   * `reachable`: the VM must get through. `blocked`: no packet may arrive at all. `closed`:
   * the address is reachable by design, and nothing may be listening on the port.
   */
  expect: 'reachable' | 'blocked' | 'closed';
}

export interface ProbeResult extends Probe {
  /** What the VM saw: `open`, `refused`, `timeout`, `unreachable`, `nogateway`, or `not run`. */
  saw: string;
  ok: boolean;
}

export interface Listener {
  port: number;
  /** The program that listens, as `lsof` names it. */
  command: string;
}

const PORTS = [22, 80, 443, 445, 5000, 8080];
/** What a Mac commonly listens on for every network: SSH, web, file and screen sharing, AirPlay. */
const GATEWAY_PORTS = [22, 80, 88, 443, 445, 548, 3283, 5000, 5900, 7000, 8080];

/** What a job must not reach: this Mac on every address it has, and the router. */
export function probes(host: {
  addresses: string[];
  gateway: string | null;
  /** What this Mac listens on for every network, where known. */
  listening?: readonly Listener[];
}): Probe[] {
  const list: Probe[] = [
    {
      what: 'the internet: github.com',
      target: { url: 'https://github.com' },
      expect: 'reachable',
    },
    {
      what: 'the internet: registry.npmjs.org',
      target: { url: 'https://registry.npmjs.org' },
      expect: 'reachable',
    },
  ];
  const tcp = (what: string, address: string, port: number): Probe => ({
    what: `${what} ${address}:${port}`,
    target: { host: address, port },
    expect: 'blocked',
  });
  if (host.gateway)
    for (const port of [53, 80, 443]) list.push(tcp('your router', host.gateway, port));
  for (const address of host.addresses) {
    for (const port of PORTS) list.push(tcp('this Mac at', address, port));
  }
  // The one address of this Mac a VM can always reach is its own gateway, for DHCP and DNS.
  // Whatever else the Mac serves to every network is served there too.
  const programs = new Map((host.listening ?? []).map((l) => [l.port, l.command]));
  const ports = [...new Set([...GATEWAY_PORTS, ...programs.keys()])].sort((a, b) => a - b);
  for (const port of ports) {
    const program = programs.get(port);
    list.push({
      what: `this Mac at the VM's gateway, port ${port}${program ? ` (${program})` : ''}`,
      target: { gateway: port },
      expect: 'closed',
    });
  }
  return list;
}

/**
 * The script run in the guest. Every probe prints `probe <index> <what it saw>`. A TCP
 * connect has three outcomes that matter: `open`, `refused` (the packet arrived and was
 * turned away, so the address is reachable), and `timeout` (nothing came back: blocked).
 */
export function probeScript(list: readonly Probe[]): string {
  const lines = list.map((probe, index) => {
    if ('url' in probe.target) {
      return `( if curl -s -o /dev/null -m 6 '${probe.target.url}'; then echo "probe ${index} open"; else echo "probe ${index} unreachable"; fi ) &`;
    }
    const address =
      'gateway' in probe.target
        ? `$GW/${probe.target.gateway}`
        : `${probe.target.host}/${probe.target.port}`;
    // With no gateway found, a probe of it would connect to the VM itself and prove nothing.
    const guard =
      'gateway' in probe.target
        ? `[ -z "$GW" ] && { echo "probe ${index} nogateway"; exit; }; `
        : '';
    return [
      `( ${guard}err=$(timeout 4 bash -c "exec 3<>/dev/tcp/${address}" 2>&1); code=$?`,
      `if [ $code -eq 0 ]; then saw=open; elif [ $code -eq 124 ]; then saw=timeout;`,
      `elif echo "$err" | grep -qi refused; then saw=refused; else saw=unreachable; fi`,
      `echo "probe ${index} $saw" ) &`,
    ].join('\n');
  });
  return ["GW=$(ip route | awk '/^default/{print $3; exit}')", ...lines, 'wait'].join('\n');
}

/** Whether what the VM saw means a packet got there and an answer came back. */
export function reached(saw: string): boolean {
  return saw === 'open' || saw === 'refused';
}

/** Whether a probe that saw `saw` went the way it should. A probe that never ran proves nothing. */
export function passed(expect: Probe['expect'], saw: string): boolean {
  if (saw === 'not run') return false;
  // Only an answer from the gateway shows the port was really tried: a refusal, or silence.
  if (expect === 'closed') return saw === 'refused' || saw === 'timeout';
  return reached(saw) === (expect === 'reachable');
}

/** What this Mac listens on for every network (`*:port`), from `lsof`'s output. */
export function wildcardListeners(lsof: string): Listener[] {
  const found = new Map<number, string>();
  for (const line of lsof.split('\n')) {
    const match = /^(\S+)\s.*\sTCP \*:(\d+) \(LISTEN\)/.exec(line);
    if (match?.[1] && match[2]) found.set(Number(match[2]), match[1]);
  }
  return [...found].map(([port, command]) => ({ port, command }));
}

/** Asks `lsof`. It sees this user's programs; the common system ports are probed anyway. */
export function listening(): Promise<Listener[]> {
  return new Promise((resolve) => {
    // +c0: the program's whole name, not its first nine letters.
    execFile('lsof', ['+c0', '-nP', '-iTCP', '-sTCP:LISTEN'], (error, stdout) => {
      // lsof exits 1 when nothing listens at all; what it printed is still the answer.
      if (error && stdout === '') {
        console.warn('minitart: lsof failed; only the common ports are tried');
      }
      resolve(wildcardListeners(stdout));
    });
  });
}

export function hostAddresses(): string[] {
  const addresses: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    // The VM bridge's own address is the VM's gateway, which Softnet lets through by design.
    if (name.startsWith('bridge')) continue;
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

export function defaultGateway(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('route', ['-n', 'get', 'default'], (error, stdout) => {
      resolve(error ? null : (/gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null));
    });
  });
}

export async function selftest(options: {
  tart: Tart;
  image: string;
  network: Network;
  host: { addresses: string[]; gateway: string | null; listening?: readonly Listener[] };
  print: (line: string) => void;
}): Promise<ProbeResult[]> {
  const { tart, image, network, print } = options;
  // Not a job VM's name: a running manager deletes job VMs it does not know.
  const name = `minitart-selftest-${randomBytes(3).toString('hex')}`;
  const list = probes(options.host);
  await tart.clone(image, name);
  try {
    let exited = false;
    void tart
      .boot(name, network, () => {})
      .then(() => {
        exited = true;
      });
    for (let waited = 0; (await tart.exec(name, ['true'])) !== 0; waited++) {
      if (exited) throw new Error('the VM stopped while booting');
      if (waited > 120) throw new Error('the VM did not come up in time');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    print(`Probing from ${name} (${list.length} checks)`);
    const seen = new Map<number, string>();
    await tart.exec(name, guestShell('linux', probeScript(list)), {
      onLine: (line) => {
        const match = /^probe (\d+) (\w+)$/.exec(line);
        if (match?.[2] !== undefined) seen.set(Number(match[1]), match[2]);
      },
    });
    return list.map((probe, index) => {
      const saw = seen.get(index) ?? 'not run';
      return { ...probe, saw, ok: passed(probe.expect, saw) };
    });
  } finally {
    await tart.stop(name).catch(() => {});
    await tart.remove(name).catch(() => {});
  }
}
