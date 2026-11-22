// What the dashboard's API answers, apart from HTTP: the server (server.ts) asks it for each
// request it lets in, and the demo on the site (demo-page.ts, D28) asks it in the browser.
// So nothing here may need Node to run: only what a browser has too.

import type { Check } from './doctor.ts';
import type { AppCredentials } from './github/app.ts';
import type { GitHub } from './github/types.ts';
import type { Manager } from './manager.ts';
import { KEEP_MS, localDay, type History } from './history.ts';
import { PRICES_CHECKED, PROVIDERS } from './pricing.ts';
import type { ResourcesView } from './resources.ts';
import { historyView, rangeFor, stepFor } from './history-view.ts';
import { mergeSettings, SettingsError, type Machine } from './settings.ts';
import type { TailnetName } from './tailnet.ts';
import { VERSION } from './version.ts';

export interface ApiDeps {
  manager: Manager;
  github: () => GitHub | null;
  app: () => AppCredentials | null;
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
  /** The Mac's name as the page shows it. */
  machineName: string;
  /**
   * The tailnet names Tailscale forwards to the server (D20). One with something against it
   * (Funnel, plain HTTP) is never answered to.
   */
  tailnet?: () => readonly TailnetName[];
}

/** An answer: JSON, or text. */
export type Reply = { status: number; json: unknown } | { status: number; text: string };

/** Jobs on a page of the Jobs view. */
export const JOBS_PER_PAGE = 50;
export const MAX_LOG = 1024 * 1024;

export interface Api {
  /** What the page draws, and what /api/events sends each time it changes. */
  state(): unknown;
  /** The answer to a GET of `path`, or null when it is not the API's. */
  get(path: string, query: URLSearchParams): Promise<Reply | null>;
  /** The answer to a POST of `body` to `path`, or null when it is not the API's. */
  post(path: string, body: string): Reply | null;
}

export function createApi(deps: ApiDeps): Api {
  const state = () => ({
    ...deps.manager.snapshot(),
    health: deps.health(),
    app: appView(deps.app()),
    machine: { name: deps.machineName, ...deps.machine },
    // For the menu bar app (D26): which minitart this is, and where else it is served.
    version: VERSION,
    tailnet: (deps.tailnet?.() ?? [])
      .filter((name) => name.refused === null)
      .map((name) => name.origin),
  });
  const json = (status: number, value: unknown): Reply => ({ status, json: value });
  const text = (status: number, value: string): Reply => ({ status, text: value });

  async function get(path: string, query: URLSearchParams): Promise<Reply | null> {
    if (path === '/api/state') return json(200, state());
    // Apart from the state: an hour of points is more than every change needs to carry.
    if (path === '/api/resources') return json(200, deps.resources?.() ?? null);
    if (path === '/api/jobs') return jobsPage(query);
    if (path === '/api/usage') {
      // The last `days` days by the Mac's calendar, today included (D25).
      const days = Number(query.get('days') ?? '30');
      if (!Number.isInteger(days) || days < 1 || days > 366) {
        return text(400, 'days must be a whole number from 1 to 366');
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
      return json(200, {
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
      const days = Number(query.get('days') ?? '1');
      if (![1, 7, 30, 90, 365].includes(days)) {
        return text(400, 'days must be 1, 7, 30, 90 or 365');
      }
      const now = Date.now();
      const endAsked = query.get('end') || null;
      const end = endAsked === null ? now : Number(endAsked);
      if (!Number.isInteger(end) || end < 0) {
        return text(400, 'end must be a time in milliseconds');
      }
      const { from, to } = rangeFor(days, Math.min(end, now));
      const resources = deps.resources?.() ?? null;
      return json(200, {
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
      return json(200, {
        history: deps.history?.stats() ?? null,
        keepDays: Math.round(KEEP_MS / 86_400_000),
        logs: deps.logs?.() ?? null,
        own: deps.ownLogs?.() ?? [],
      });
    }

    const vmLog = /^\/api\/vms\/(minitart-(?:linux|macos)-[0-9a-f]{6})\/log$/.exec(path);
    if (vmLog?.[1] !== undefined) {
      const lines = deps.manager.vmLog(vmLog[1]);
      if (lines) return text(200, lines.join('\n'));
      // One that ended a while ago, or before a restart: as it was written to disk.
      const saved = deps.vmLogFile?.(vmLog[1], MAX_LOG) ?? null;
      return saved !== null
        ? text(200, saved)
        : text(
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
      if (repo === null || github === null) return text(404, 'No such job');
      try {
        const log = await github.jobLog(repo, jobId);
        return text(200, log.length > MAX_LOG ? log.slice(-MAX_LOG) : log);
      } catch (error) {
        return text(502, error instanceof Error ? error.message : 'GitHub failed');
      }
    }
    return null;
  }

  function post(path: string, body: string): Reply | null {
    if (path === '/api/settings') {
      let patch: unknown;
      try {
        patch = JSON.parse(body);
      } catch {
        return text(400, 'Not JSON');
      }
      try {
        deps.manager.updateSettings(mergeSettings(deps.manager.settings, patch, deps.machine));
      } catch (error) {
        if (error instanceof SettingsError) return text(400, error.message);
        throw error;
      }
      return json(200, state());
    }
    if (path === '/api/drain') {
      let wanted: unknown;
      try {
        wanted = (JSON.parse(body) as { draining?: unknown }).draining;
      } catch {
        return text(400, 'Not JSON');
      }
      if (typeof wanted !== 'boolean') return text(400, 'draining must be true or false');
      deps.manager.setDraining(wanted);
      return json(200, state());
    }
    return null;
  }

  /** A page of the history, newest first; the query is untrusted and checked. */
  function jobsPage(query: URLSearchParams): Reply {
    const page = Number(query.get('page') ?? '1');
    const repo = query.get('repo') || undefined;
    const result = query.get('result') || undefined;
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000) {
      return text(400, 'page must be a whole number from 1');
    }
    if (repo !== undefined && !/^[A-Za-z0-9_-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) {
      return text(400, 'repo must be owner/name');
    }
    if (result !== undefined && !/^[a-z_]{1,32}$/.test(result)) {
      return text(400, 'result must be a word such as success or failure');
    }
    // The last `days` days by the Mac's calendar, today included, or every job kept.
    const daysAsked = query.get('days') || undefined;
    const days = daysAsked === undefined ? undefined : Number(daysAsked);
    if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 366)) {
      return text(400, 'days must be a whole number from 1 to 366');
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
    return json(200, {
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

  return { state, get, post };
}

function appView(app: AppCredentials | null): { slug: string; htmlUrl: string } | null {
  // Never the key.
  return app ? { slug: app.slug, htmlUrl: app.htmlUrl } : null;
}
