// The GitHub REST client: plain fetch, no SDK (D07). Reads are conditional (ETag), so a poll
// that finds nothing new costs nothing against the rate limit.

import { GitHubError, type GitHub, type Job, type JobStatus, type Repo } from './types.ts';

const API = 'https://api.github.com';

/** Who the client acts as: which repos it may touch, and a token for each. */
export interface Auth {
  repos(): Promise<Repo[]>;
  token(repo: string): Promise<string>;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'minitart',
  };
}

/** Throws a `GitHubError` for a response that is not a success. */
export async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  const remaining = response.headers.get('x-ratelimit-remaining');
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  const retryAfter = Number(response.headers.get('retry-after'));
  let retryAt: number | null = null;
  if (retryAfter > 0) retryAt = Date.now() + retryAfter * 1000;
  else if (remaining === '0' && reset > 0) retryAt = reset * 1000;
  let detail = '';
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') detail = `: ${body.message}`;
  } catch {
    // The status is the message.
  }
  throw new GitHubError(response.status, `${what} failed (${response.status})${detail}`, retryAt);
}

const STATUSES: Record<string, JobStatus> = {
  queued: 'queued',
  in_progress: 'in_progress',
  completed: 'completed',
  waiting: 'waiting',
  pending: 'pending',
  requested: 'pending',
};

/**
 * Every status GitHub gives a workflow run that has not completed. All of them are asked
 * for, and they are what a run in the unfiltered list must have to be kept: a run left out
 * is a run whose queued job is never seen.
 */
const ACTIVE_RUN_STATUSES = ['requested', 'queued', 'in_progress', 'waiting', 'pending'] as const;

export class GitHubClient implements GitHub {
  readonly #auth: Auth;
  readonly #fetch: Fetch;
  readonly #cache = new Map<string, { etag: string; body: unknown }>();
  /** Who triggered each run seen, or '' for one GitHub did not say: the job lists do not. */
  readonly #actors = new Map<number, string>();

  constructor(auth: Auth, fetchImpl: Fetch = fetch) {
    this.#auth = auth;
    this.#fetch = fetchImpl;
  }

  repos(): Promise<Repo[]> {
    return this.#auth.repos();
  }

  async activeRuns(repo: string): Promise<number[]> {
    // Asked by status, so a burst of finished runs never pushes a waiting one out of view.
    // A run in progress matters as much as a queued one: its later jobs queue as earlier
    // ones finish. A waiting run (an approval is pending) can still have jobs to run. So
    // can a pending one: a run that took over its concurrency group from a cancelled run
    // has been seen to stay pending while its job sat queued, with no runner to take it.
    // (A run that is still waiting for its group lists no jobs at all.) Whether a job is
    // ready is the job's own status, never the run's.
    const ids = new Set<number>();
    for (const status of ACTIVE_RUN_STATUSES) {
      const runs = (await this.#pages(
        repo,
        `/repos/${repo}/actions/runs?status=${status}`,
        (page) => (page as { workflow_runs?: unknown[] }).workflow_runs ?? [],
      )) as RawRun[];
      for (const run of runs) {
        ids.add(run.id);
        this.#noteActor(run);
      }
    }
    // The lists by status can miss a run: GitHub has been seen to leave a queued run out of
    // every one of them while the run itself, and the list with no filter, said `queued`,
    // so its job waited for good. The newest runs, unfiltered, are read too, and any of
    // them that has not completed is kept.
    const newest = (await this.#get(repo, `/repos/${repo}/actions/runs?per_page=100`)) as {
      workflow_runs?: RawRun[];
    };
    for (const run of newest.workflow_runs ?? []) {
      this.#noteActor(run);
      if ((ACTIVE_RUN_STATUSES as readonly (string | undefined)[]).includes(run.status)) {
        ids.add(run.id);
      }
    }
    return [...ids];
  }

  async jobs(repo: string, runId: number): Promise<Job[]> {
    const jobs = (await this.#pages(
      repo,
      `/repos/${repo}/actions/runs/${runId}/jobs?filter=latest`,
      (page) => (page as { jobs?: unknown[] }).jobs ?? [],
    )) as RawJob[];
    // A run not seen in the lists (one that finished before minitart looked) is asked for.
    // Who ran it is a nicety: not knowing never costs the jobs themselves.
    if (jobs.length > 0 && !this.#actors.has(runId)) {
      try {
        this.#noteActor((await this.#get(repo, `/repos/${repo}/actions/runs/${runId}`)) as RawRun);
      } catch {
        // Shown without an author, and not asked about again.
        this.#actors.set(runId, '');
      }
    }
    return jobs.map((job) => ({
      id: job.id,
      runId: job.run_id,
      repo,
      name: job.name,
      workflow: job.workflow_name ?? '',
      labels: job.labels ?? [],
      status: STATUSES[job.status] ?? 'pending',
      conclusion: job.conclusion ?? null,
      runnerName: job.runner_name || null,
      actor: this.#actors.get(job.run_id) || null,
      url: job.html_url ?? '',
      createdAt: job.created_at,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
    }));
  }

  async registerRunner(
    repo: string,
    name: string,
    labels: string[],
  ): Promise<{ runnerId: number; jitConfig: string }> {
    const response = await this.#send(
      repo,
      'POST',
      `/repos/${repo}/actions/runners/generate-jitconfig`,
      {
        name,
        // 1 is the Default group, the only one a repository has.
        runner_group_id: 1,
        labels,
        work_folder: '_work',
      },
    );
    const body = (await response.json()) as {
      runner: { id: number };
      encoded_jit_config: string;
    };
    return { runnerId: body.runner.id, jitConfig: body.encoded_jit_config };
  }

  async removeRunner(repo: string, runnerId: number): Promise<void> {
    try {
      await this.#send(repo, 'DELETE', `/repos/${repo}/actions/runners/${runnerId}`);
    } catch (error) {
      // A runner that took its job removes itself.
      if (error instanceof GitHubError && error.status === 404) return;
      throw error;
    }
  }

  async jobLog(repo: string, jobId: number): Promise<string> {
    // GitHub answers with a redirect to a short-lived download URL. fetch follows it and,
    // because the host changes, leaves the token behind.
    const token = await this.#auth.token(repo);
    const response = await this.#fetch(`${API}/repos/${repo}/actions/jobs/${jobId}/logs`, {
      headers: githubHeaders(token),
    });
    await expectOk(response, 'Reading the job log');
    return response.text();
  }

  /** Every page of a list, a hundred items at a time, up to a thousand. */
  async #pages(
    repo: string,
    path: string,
    items: (page: unknown) => unknown[],
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 10; page++) {
      const found = items(await this.#get(repo, `${path}&per_page=100&page=${page}`));
      all.push(...found);
      if (found.length < 100) break;
    }
    return all;
  }

  async #get(repo: string, path: string): Promise<unknown> {
    const token = await this.#auth.token(repo);
    const cached = this.#cache.get(path);
    const headers = githubHeaders(token);
    if (cached) headers['if-none-match'] = cached.etag;
    const response = await this.#fetch(`${API}${path}`, { headers });
    if (response.status === 304 && cached) return cached.body;
    await expectOk(response, `GET ${path}`);
    const body: unknown = await response.json();
    const etag = response.headers.get('etag');
    if (etag) {
      // Finished runs are never asked for again; dropping everything now and then is enough.
      if (this.#cache.size > 2000) this.#cache.clear();
      this.#cache.set(path, { etag, body });
    }
    return body;
  }

  #noteActor(run: RawRun): void {
    const login = run.triggering_actor?.login ?? run.actor?.login;
    // Kept for the runs of the last while; like the cache, cleared now and then. A run with
    // no login is remembered too, so that it is not asked about again every poll.
    if (this.#actors.size > 5000) this.#actors.clear();
    this.#actors.set(run.id, typeof login === 'string' ? login : '');
  }

  async #send(repo: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#auth.token(repo);
    const init: RequestInit = { method, headers: githubHeaders(token) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.#fetch(`${API}${path}`, init);
    return expectOk(response, `${method} ${path}`);
  }
}

interface RawRun {
  id: number;
  status?: string;
  actor?: { login?: string } | null;
  /** Who started this attempt: the same as `actor`, except for a run run again. */
  triggering_actor?: { login?: string } | null;
}

interface RawJob {
  id: number;
  run_id: number;
  name: string;
  workflow_name?: string | null;
  labels?: string[];
  status: string;
  conclusion?: string | null;
  runner_name?: string | null;
  html_url?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
}
