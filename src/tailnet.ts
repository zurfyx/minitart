// The dashboard on the owner's tailnet (D20). minitart itself never listens anywhere but
// 127.0.0.1: Tailscale Serve, which the owner sets up, forwards a tailnet name to that port.
// This file asks Tailscale which names it forwards here, so the server can answer to them.

import { execFile } from 'node:child_process';

export interface TailnetName {
  /** The name as a request's `Host` header carries it. */
  host: string;
  /** What a browser opens: `https://minitart.example.ts.net`. */
  origin: string;
  /** The Tailscale Service the name belongs to (`svc:minitart`), or `null` for the Mac's own name. */
  service: string | null;
  /** Whether Tailscale Funnel publishes the name to the whole internet. */
  funnel: boolean;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/**
 * The tailnet names that Tailscale Serve forwards to `port` on this Mac, from the output of
 * `tailscale serve status --json`. The config is read defensively: anything not understood
 * yields no name, and a name nobody forwards here is never answered to.
 */
export function tailnetNames(config: unknown, port: number): TailnetName[] {
  const root = object(config);
  const targets = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const funnels = object(root['AllowFunnel']);
  const names: TailnetName[] = [];

  const read = (section: Json, service: string | null) => {
    const tcp = object(section['TCP']);
    for (const [hostPort, site] of Object.entries(object(section['Web']))) {
      const handlers = Object.values(object(object(site)['Handlers']));
      // Only a name that forwards its whole self here: a path of some other site does not
      // make that site minitart's.
      const ours =
        handlers.length > 0 && handlers.every((h) => targets.has(String(object(h)['Proxy'])));
      const match = /^([a-z0-9.-]+):(\d+)$/i.exec(hostPort);
      if (!ours || !match?.[1] || !match[2]) continue;
      const name = match[1].toLowerCase();
      const https = object(tcp[match[2]])['HTTPS'] === true;
      const standard = match[2] === (https ? '443' : '80');
      const host = standard ? name : `${name}:${match[2]}`;
      names.push({
        host,
        origin: `${https ? 'https' : 'http'}://${host}`,
        service,
        funnel: funnels[hostPort] === true || object(section['AllowFunnel'])[hostPort] === true,
      });
    }
  };

  read(root, null);
  for (const [service, section] of Object.entries(object(root['Services']))) {
    read(object(section), service);
  }
  for (const section of Object.values(object(root['Foreground']))) read(object(section), null);
  return names;
}

/** Asks Tailscale. No Tailscale, or no answer, is simply no names. */
export function readTailnet(
  port: number,
  run: () => Promise<string | null> = serveStatus,
): Promise<TailnetName[]> {
  return run().then(
    (output) => {
      if (output === null) return [];
      try {
        return tailnetNames(JSON.parse(output), port);
      } catch {
        return [];
      }
    },
    () => [],
  );
}

function serveStatus(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('tailscale', ['serve', 'status', '--json'], { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}
