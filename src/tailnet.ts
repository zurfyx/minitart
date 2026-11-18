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
  /**
   * Why the dashboard does not answer to this name, or `null` when it does.
   * `funnel`: Tailscale Funnel publishes it to the whole internet.
   * `plain-http`: it is not HTTPS, and a browser guards a plain-HTTP page less.
   * `raw-tcp`: Tailscale forwards bare TCP, so there is no name to check at all.
   */
  refused: 'funnel' | 'plain-http' | 'raw-tcp' | null;
  /** The command that puts it right, when there is one. */
  fix: string | null;
}

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** Whether a Serve target is this Mac's dashboard: `http://127.0.0.1:<port>`, however written. */
function isDashboard(target: unknown, port: number): boolean {
  if (typeof target !== 'string') return false;
  let url: URL;
  try {
    url = new URL(target.includes('://') ? target : `http://${target}`);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
    url.port === String(port) &&
    url.pathname === '/' &&
    url.search === ''
  );
}

/**
 * The tailnet names that Tailscale Serve forwards to `port` on this Mac, from the output of
 * `tailscale serve status --json`. The config is read defensively: anything not understood
 * yields no name, and a name nobody forwards here is never answered to.
 */
export function tailnetNames(config: unknown, port: number): TailnetName[] {
  const root = object(config);
  const sections: [section: Json, service: string | null][] = [[root, null]];
  for (const [service, section] of Object.entries(object(root['Services']))) {
    sections.push([object(section), service]);
  }
  for (const section of Object.values(object(root['Foreground']))) {
    sections.push([object(section), null]);
  }
  // Funnel is on for a name if any part of the config says so.
  const funnelled = new Set<string>();
  for (const [section] of sections) {
    for (const [hostPort, on] of Object.entries(object(section['AllowFunnel']))) {
      if (on === true) funnelled.add(hostPort.toLowerCase());
    }
  }

  const names: TailnetName[] = [];
  for (const [section, service] of sections) {
    const tcp = object(section['TCP']);
    for (const [hostPort, site] of Object.entries(object(section['Web']))) {
      const handlers = Object.values(object(object(site)['Handlers']));
      // Only a name that forwards its whole self here: a path of some other site does not
      // make that site minitart's.
      const ours =
        handlers.length > 0 && handlers.every((h) => isDashboard(object(h)['Proxy'], port));
      const match = /^([a-z0-9.-]+):(\d+)$/i.exec(hostPort);
      if (!ours || !match?.[1] || !match[2]) continue;
      const name = match[1].toLowerCase();
      const outside = match[2];
      const https = object(tcp[outside])['HTTPS'] === true;
      const host = outside === (https ? '443' : '80') ? name : `${name}:${outside}`;
      const flag = service === null ? '' : `--service=${service} `;
      // Serving the name again, as HTTPS and without Funnel, replaces what is there for that
      // port and touches nothing else.
      const again = `tailscale serve ${flag}--bg --https=${https ? outside : '443'} http://127.0.0.1:${port}`;
      const refused = funnelled.has(hostPort.toLowerCase())
        ? 'funnel'
        : https
          ? null
          : 'plain-http';
      names.push({
        host,
        origin: `${https ? 'https' : 'http'}://${host}`,
        service,
        refused,
        fix: refused === null ? null : again,
      });
    }
    // Bare TCP forwarded to the dashboard carries whatever Host the far end likes.
    for (const [outside, handler] of Object.entries(tcp)) {
      if (!isDashboard(object(handler)['TCPForward'], port)) continue;
      names.push({
        host: `tcp:${outside}`,
        origin: '',
        service,
        refused: 'raw-tcp',
        fix: `tailscale serve --tcp=${outside} off`,
      });
    }
  }
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
