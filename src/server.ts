// The dashboard's HTTP server (D10). It serves one page and the state behind it. It listens
// on 127.0.0.1 and refuses anything that did not come from there; the one other way in is
// Tailscale Serve, which the owner sets up and which forwards a tailnet name to this port
// (D20). There are no accounts: who may open the page is who can reach it.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createApi, type ApiDeps, type Reply } from './api.ts';
import { appManifest, convertManifestCode, type AppCredentials } from './github/app.ts';
import type { Fetch } from './github/client.ts';
import { SettingsError } from './settings.ts';
import type { TailnetName } from './tailnet.ts';

export interface ServerDeps extends Omit<ApiDeps, 'machineName'> {
  saveApp: (app: AppCredentials) => void;
  port: number;
  dashboardDir: string;
  fetch?: Fetch;
  /** The Mac's name as the page shows it: its host name unless given. */
  machineName?: string;
  /** Whether a connection from this address is from the Mac itself. */
  isLocal?: (address: string | undefined) => boolean;
}

/** The page's files, by the path each is served at. The demo's build copies them too (D28). */
export const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/cost.js': ['cost.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/tokens.css': ['tokens.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  // What makes the page an app that can be installed: its manifest and its icons.
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/icons/favicon-32.png': ['icons/favicon-32.png', 'image/png'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/icon-maskable-192.png': ['icons/icon-maskable-192.png', 'image/png'],
  '/icons/icon-maskable-512.png': ['icons/icon-maskable-512.png', 'image/png'],
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; form-action https://github.com; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const MAX_BODY = 64 * 1024;

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createDashboardServer(deps: ServerDeps): Server {
  const fetchImpl = deps.fetch ?? fetch;
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${deps.port}`));
  /** The pending "create the GitHub App" round trip: its secret and when it expires. */
  let setup: { state: string; expiresAt: number } | null = null;
  // What each address of the API answers; this server says who may ask.
  const api = createApi({ ...deps, machineName: () => deps.machineName ?? hostname() });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = (request.headers.host ?? '').toLowerCase();
    // A page on another site cannot read this one by pointing its own name at 127.0.0.1.
    // The page is opened at 127.0.0.1, or at a name Tailscale forwards here. Anything else is
    // a page on another site pointing a name of its own at this port.
    const origin = hosts.has(host) ? `http://${host}` : tailnetOrigin(deps.tailnet?.() ?? [], host);
    if (origin === null) return send(response, 421, 'Unknown host');
    // Tailscale marks what Funnel brings in from the internet, and strips the mark from
    // anything a client sends. Refusing it does not wait for the names to be read again.
    if (request.headers['tailscale-funnel-request'] !== undefined) {
      return send(response, 421, 'Not served to the internet');
    }
    // The server listens on 127.0.0.1 only, and Tailscale's proxy connects from there too;
    // this holds even if the listening address is ever changed.
    if (!(deps.isLocal ?? isLoopback)(request.socket.remoteAddress)) {
      return send(response, 403, 'The dashboard is served to this Mac only');
    }
    const url = new URL(request.url ?? '/', origin);
    const path = url.pathname;

    if (request.method === 'GET') {
      const file = STATIC[path];
      if (file) {
        const body = await readFile(join(deps.dashboardDir, file[0]));
        response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': file[1] });
        response.end(body);
        return;
      }
      if (path === '/api/events') return events(request, response);

      if (path === '/setup/manifest') {
        if (deps.app()) return send(response, 409, 'The GitHub App already exists');
        // Only this page may start the round trip: a browser says where a request came from.
        const site = request.headers['sec-fetch-site'];
        if (site !== undefined && site !== 'same-origin')
          return send(response, 403, 'Wrong origin');
        setup = { state: randomBytes(24).toString('hex'), expiresAt: Date.now() + 15 * 60_000 };
        const name = `minitart-${
          hostname()
            .split('.')[0]
            ?.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-') ?? 'mac'
        }`;
        return json(response, 200, {
          action: `https://github.com/settings/apps/new?state=${setup.state}`,
          manifest: JSON.stringify(appManifest(name.slice(0, 34), origin)),
        });
      }

      if (path === '/setup/callback') {
        const pending = setup;
        const given = url.searchParams.get('state') ?? '';
        // A request with the wrong secret changes nothing: it cannot cancel the real one.
        if (!pending || Date.now() > pending.expiresAt || !same(given, pending.state)) {
          return send(response, 400, 'This link has expired. Start again from the dashboard.');
        }
        setup = null;
        if (deps.app()) return send(response, 409, 'The GitHub App already exists');
        try {
          const app = await convertManifestCode(url.searchParams.get('code') ?? '', fetchImpl);
          deps.saveApp(app);
          // Next stop: GitHub's page for choosing the repos the App is installed on.
          response.writeHead(302, {
            ...SECURITY_HEADERS,
            location: `${app.htmlUrl}/installations/new`,
          });
          response.end();
        } catch (error) {
          send(response, 502, error instanceof Error ? error.message : 'GitHub failed');
        }
        return;
      }
      const reply = await api.get(path, url.searchParams);
      return reply ? answer(response, reply) : send(response, 404, 'Not found');
    }

    if (request.method === 'POST' && (path === '/api/settings' || path === '/api/drain')) {
      // A form on another site can post here; it cannot set this header pair.
      if (request.headers.origin !== origin) return send(response, 403, 'Wrong origin');
      if (
        path === '/api/settings' &&
        !(request.headers['content-type'] ?? '').startsWith('application/json')
      ) {
        return send(response, 415, 'Send JSON');
      }
      let text: string;
      try {
        text = await body(request);
      } catch {
        return send(response, 400, 'Not JSON');
      }
      const reply = api.post(path, text);
      return reply ? answer(response, reply) : send(response, 404, 'Not found');
    }
    return send(response, 405, 'Method not allowed');
  }

  function events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
    });
    const push = () => response.write(`data: ${JSON.stringify(api.state())}\n\n`);
    // A VM prints many lines a second; the page needs the state a few times a second.
    let timer: NodeJS.Timeout | null = null;
    const unsubscribe = deps.manager.onChange(() => {
      timer ??= setTimeout(() => {
        timer = null;
        push();
      }, 250);
    });
    const heartbeat = setInterval(push, 15_000);
    push();
    request.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
    });
  }

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) send(response, 500, 'Something went wrong');
      else response.end();
      console.error(error);
    });
  });
}

/** The origin to answer `host` under, if it is a tailnet name with nothing against it. */
function tailnetOrigin(names: readonly TailnetName[], host: string): string | null {
  const matching = names.filter((name) => name.host === host);
  if (matching.length === 0 || matching.some((name) => name.refused !== null)) return null;
  return matching[0]?.origin ?? null;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function answer(response: ServerResponse, reply: Reply): void {
  if ('json' in reply) json(response, reply.status, reply.json);
  else send(response, reply.status, reply.text);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new SettingsError('The request is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
