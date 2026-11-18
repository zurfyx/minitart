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

export class GitHubClient implements GitHub {
  readonly #auth: Auth;
  readonly #fetch: Fetch;
  readonly #cache = new Map<string, { etag: string; body: unknown }>();

  constructor(auth: Auth, fetchImpl: Fetch = fetch) {
    this.#auth = auth;
    this.#fetch = fetchImpl;
  }

  repos(): Promise<Repo[]> {
    return this.#auth.repos();
  }

  async activeRuns(repo: string): Promise<number[]> {
    // The newest fifty runs of any status: one request finds the queued ones and the ones in
    // progress, whose later jobs queue as earlier ones finish.
    const body = (await this.#get(repo, `/repos/${repo}/actions/runs?per_page=50`)) as {
      workflow_runs?: { id: number; status: string }[];
    };
    return (body.workflow_runs ?? []).filter((run) => run.status !== 'completed').map((r) => r.id);
  }

  async jobs(repo: string, runId: number): Promise<Job[]> {
    const body = (await this.#get(
      repo,
      `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
    )) as { jobs?: RawJob[] };
    return (body.jobs ?? []).map((job) => ({
      id: job.id,
      runId: job.run_id,
      repo,
      name: job.name,
      workflow: job.workflow_name ?? '',
      labels: job.labels ?? [],
      status: STATUSES[job.status] ?? 'pending',
      conclusion: job.conclusion ?? null,
      runnerName: job.runner_name || null,
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
      if (this.#cache.size > 500) this.#cache.clear();
      this.#cache.set(path, { etag, body });
    }
    return body;
  }

  async #send(repo: string, method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.#auth.token(repo);
    const init: RequestInit = { method, headers: githubHeaders(token) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await this.#fetch(`${API}${path}`, init);
    return expectOk(response, `${method} ${path}`);
  }
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
