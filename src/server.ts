// The dashboard's HTTP server (D10). It serves one page and the state behind it. It listens
// on 127.0.0.1 and refuses anything that did not come from there; the one other way in is
// Tailscale Serve, which the owner sets up and which forwards a tailnet name to this port
// (D20). There are no accounts: who may open the page is who can reach it.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Check } from './doctor.ts';
import { appManifest, convertManifestCode, type AppCredentials } from './github/app.ts';
import type { Fetch } from './github/client.ts';
import type { GitHub } from './github/types.ts';
import type { Manager } from './manager.ts';
import { KEEP_MS, localDay, type History } from './history.ts';
import { PRICES_CHECKED, PROVIDERS } from './pricing.ts';
import type { ResourcesView } from './resources.ts';
import { historyView, rangeFor, stepFor } from './history-view.ts';
import { mergeSettings, SettingsError, type Machine } from './settings.ts';
import type { TailnetName } from './tailnet.ts';
import { VERSION } from './version.ts';

export interface ServerDeps {
  manager: Manager;
  github: () => GitHub | null;
  app: () => AppCredentials | null;
  saveApp: (app: AppCredentials) => void;
  health: () => Check[];
  /** The Mac's CPU, memory and disk over the last hour, for the charts (D23). */
  resources?: () => ResourcesView | null;
  /** Every job that ran, for the Jobs view (D24). */
  history?: History;
  /** A VM's log as written to disk, its last `maxBytes`, or null. The name is a job VM's. */
  vmLogFile?: (name: string, maxBytes: number) => string | null;
  /** The VM logs kept on disk: how many, what they take, and how many are kept at most. */
  logs?: () => { files: number; bytes: number; kept: number };
  /** minitart's own log files, where it writes what the Activity list shows, and their size. */
  ownLogs?: () => { path: string; bytes: number }[];
  machine: Machine;
  port: number;
  /**
   * The tailnet names Tailscale forwards to this server (D20). One with something against
   * it (Funnel, plain HTTP) is never answered to.
   */
  tailnet?: () => readonly TailnetName[];
  dashboardDir: string;
  fetch?: Fetch;
  /** The Mac's name as the page shows it. */
  machineName?: string;
  /** Whether a connection from this address is from the Mac itself. */
  isLocal?: (address: string | undefined) => boolean;
}

const STATIC: Record<string, [file: string, type: string]> = {
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
/** Jobs on a page of the Jobs view. */
export const JOBS_PER_PAGE = 50;
const MAX_LOG = 1024 * 1024;

export function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function createDashboardServer(deps: ServerDeps): Server {
  const fetchImpl = deps.fetch ?? fetch;
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${deps.port}`));
  /** The pending "create the GitHub App" round trip: its secret and when it expires. */
  let setup: { state: string; expiresAt: number } | null = null;

  const state = () => ({
    ...deps.manager.snapshot(),
    health: deps.health(),
    app: appView(deps.app()),
    machine: { name: deps.machineName ?? hostname(), ...deps.machine },
    // For the menu bar app (D26): which minitart this is, and where else it is served.
    version: VERSION,
    tailnet: (deps.tailnet?.() ?? [])
      .filter((name) => name.refused === null)
      .map((name) => name.origin),
  });

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
      if (path === '/api/state') return json(response, 200, state());
      if (path === '/api/events') return events(request, response);
      // Apart from the state: an hour of points is more than every change needs to carry.
      if (path === '/api/resources') return json(response, 200, deps.resources?.() ?? null);
      if (path === '/api/jobs') return jobsPage(response, url.searchParams);
      if (path === '/api/usage') {
        // The last `days` days by the Mac's calendar, today included (D25).
        const days = Number(url.searchParams.get('days') ?? '30');
        if (!Number.isInteger(days) || days < 1 || days > 366) {
          return send(response, 400, 'days must be a whole number from 1 to 366');
        }
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        since.setDate(since.getDate() - (days - 1));
        // The dates as the Mac counts them: a page in another time zone draws the same days.
        const dates = Array.from({ length: days }, (_, index) =>
          localDay(
            new Date(since.getFullYear(), since.getMonth(), since.getDate() + index).getTime(),
          ),
        );
        const oldestAt = deps.history?.stats().oldestAt ?? null;
        return json(response, 200, {
          days,
          dates,
          since: since.getTime(),
          usage: deps.history?.usage(since.getTime()) ?? [],
          oldestDay: oldestAt === null ? null : localDay(oldestAt),
          prices: { checked: PRICES_CHECKED, providers: PROVIDERS },
        });
      }
      if (path === '/api/history') {
        // A range of whole days back from `end` (now when not given), in steps that line up
        // with the Mac's clock, as the History view steps through them (D27).
        const days = Number(url.searchParams.get('days') ?? '1');
        if (![1, 7, 30, 90, 365].includes(days)) {
          return send(response, 400, 'days must be 1, 7, 30, 90 or 365');
        }
        const now = Date.now();
        const endAsked = url.searchParams.get('end') || null;
        const end = endAsked === null ? now : Number(endAsked);
        if (!Number.isInteger(end) || end < 0) {
          return send(response, 400, 'end must be a time in milliseconds');
        }
        const { from, to } = rangeFor(days, Math.min(end, now));
        const resources = deps.resources?.() ?? null;
        return json(response, 200, {
          ...(deps.history
            ? historyView(
                deps.history,
                from,
                to,
                deps.manager.snapshot().vms.filter((vm) => vm.jobAt !== null && vm.createdAt < to),
                now,
              )
            : { from, to, stepMs: stepFor(to - from), samples: [], vms: [], oldestAt: null }),
          days,
          cores: resources?.cores ?? null,
          memoryBytes: resources?.memoryBytes ?? null,
          diskBytes: resources?.disk?.totalBytes ?? null,
        });
      }
      if (path === '/api/storage') {
        return json(response, 200, {
          history: deps.history?.stats() ?? null,
          keepDays: Math.round(KEEP_MS / 86_400_000),
          logs: deps.logs?.() ?? null,
          own: deps.ownLogs?.() ?? [],
        });
      }

      const vmLog = /^\/api\/vms\/(minitart-(?:linux|macos)-[0-9a-f]{6})\/log$/.exec(path);
      if (vmLog?.[1] !== undefined) {
        const lines = deps.manager.vmLog(vmLog[1]);
        if (lines) return send(response, 200, lines.join('\n'));
        // One that ended a while ago, or before a restart: as it was written to disk.
        const saved = deps.vmLogFile?.(vmLog[1], MAX_LOG) ?? null;
        return saved !== null
          ? send(response, 200, saved)
          : send(
              response,
              404,
              'minitart no longer has this VM’s output: it keeps that of the newest VMs only',
            );
      }

      const jobLog = /^\/api\/jobs\/(\d{1,15})\/log$/.exec(path);
      if (jobLog?.[1] !== undefined) {
        // Only jobs minitart ran: the App's token must not become a way to read any log.
        const jobId = Number(jobLog[1]);
        const repo = deps.manager.repoOfJob(jobId);
        const github = deps.github();
        if (repo === null || github === null) return send(response, 404, 'No such job');
        try {
          const log = await github.jobLog(repo, jobId);
          return send(response, 200, log.length > MAX_LOG ? log.slice(-MAX_LOG) : log);
        } catch (error) {
          return send(response, 502, error instanceof Error ? error.message : 'GitHub failed');
        }
      }

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
      return send(response, 404, 'Not found');
    }

    if (request.method === 'POST' && path === '/api/settings') {
      // A form on another site can post here; it cannot set this header pair.
      if (request.headers.origin !== origin) return send(response, 403, 'Wrong origin');
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        return send(response, 415, 'Send JSON');
      }
      let patch: unknown;
      try {
        patch = JSON.parse(await body(request));
      } catch {
        return send(response, 400, 'Not JSON');
      }
      try {
        deps.manager.updateSettings(mergeSettings(deps.manager.settings, patch, deps.machine));
      } catch (error) {
        if (error instanceof SettingsError) return send(response, 400, error.message);
        throw error;
      }
      return json(response, 200, state());
    }
    if (request.method === 'POST' && path === '/api/drain') {
      if (request.headers.origin !== origin) return send(response, 403, 'Wrong origin');
      let wanted: unknown;
      try {
        wanted = (JSON.parse(await body(request)) as { draining?: unknown }).draining;
      } catch {
        return send(response, 400, 'Not JSON');
      }
      if (typeof wanted !== 'boolean') return send(response, 400, 'draining must be true or false');
      deps.manager.setDraining(wanted);
      return json(response, 200, state());
    }
    return send(response, 405, 'Method not allowed');
  }

  /** A page of the history, newest first; the query is untrusted and checked. */
  function jobsPage(response: ServerResponse, query: URLSearchParams): void {
    const page = Number(query.get('page') ?? '1');
    const repo = query.get('repo') || undefined;
    const result = query.get('result') || undefined;
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
      return send(response, 400, 'page must be a whole number from 1');
    }
    if (repo !== undefined && !/^[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      return send(response, 400, 'repo must be owner/name');
    }
    if (result !== undefined && !/^[a-z_]{1,32}$/.test(result)) {
      return send(response, 400, 'result must be a word such as success or failure');
    }
    // The last `days` days by the Mac's calendar, today included, or every job kept.
    const daysAsked = query.get('days') || undefined;
    const days = daysAsked === undefined ? undefined : Number(daysAsked);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 366)) {
      return send(response, 400, 'days must be a whole number from 1 to 366');
    }
    let since: number | undefined;
    if (days !== undefined) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (days - 1));
      since = start.getTime();
    }
    const history = deps.history;
    const found = history
      ? history.page({
          offset: (page - 1) * JOBS_PER_PAGE,
          limit: JOBS_PER_PAGE,
          ...(repo === undefined ? {} : { repo }),
          ...(result === undefined ? {} : { conclusion: result }),
          ...(since === undefined ? {} : { since }),
        })
      : { total: 0, jobs: [] };
    json(response, 200, {
      ...found,
      page,
      pages: Math.max(1, Math.ceil(found.total / JOBS_PER_PAGE)),
      per: JOBS_PER_PAGE,
      repos: history?.repos() ?? [],
      // How many ended each way, of the repo and range asked for: the result filter shows them.
      results:
        history?.results({
          ...(repo === undefined ? {} : { repo }),
          ...(since === undefined ? {} : { since }),
        }) ?? {},
    });
  }

  function events(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream',
      connection: 'keep-alive',
    });
    const push = () => response.write(`data: ${JSON.stringify(state())}\n\n`);
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

function appView(app: AppCredentials | null): { slug: string; htmlUrl: string } | null {
  // Never the key.
  return app ? { slug: app.slug, htmlUrl: app.htmlUrl } : null;
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
