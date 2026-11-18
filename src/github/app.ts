// The GitHub App (D03). The App's private key never leaves this Mac: it signs a short-lived
// JWT, the JWT buys an installation token that lasts an hour, and the token registers
// runners. A VM only ever sees the single-use config of its own runner.

import { createSign } from 'node:crypto';
import { expectOk, githubHeaders, type Auth, type Fetch } from './client.ts';
import { GitHubError, type Repo } from './types.ts';

const API = 'https://api.github.com';

export interface AppCredentials {
  appId: number;
  slug: string;
  /** The App's private key, PEM. */
  pem: string;
  /** The App's page on GitHub, where it is installed on repos. */
  htmlUrl: string;
}

export function parseAppCredentials(value: unknown): AppCredentials | null {
  if (typeof value !== 'object' || value === null) return null;
  const { appId, slug, pem, htmlUrl } = value as Record<string, unknown>;
  if (typeof appId !== 'number' || typeof slug !== 'string' || typeof pem !== 'string') return null;
  if (typeof htmlUrl !== 'string') return null;
  return { appId, slug, pem, htmlUrl };
}

/** A JWT that says "I am this App", good for nine minutes. */
export function appJwt(app: Pick<AppCredentials, 'appId' | 'pem'>, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Issued a minute ago, so a slightly slow clock on this Mac is not "in the future".
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: String(app.appId) })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(app.pem, 'base64url');
  return `${unsigned}.${signature}`;
}

export class AppAuth implements Auth {
  readonly #app: AppCredentials;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #tokens = new Map<number, { token: string; expiresAt: number }>();
  readonly #renewals = new Map<number, Promise<string>>();
  /** Which installation each repo belongs to. */
  #installations = new Map<string, number>();
  /** The repos each installation had the last time it could be read. */
  readonly #lastRead = new Map<number, Repo[]>();
  readonly #warn: (message: string) => void;

  constructor(
    app: AppCredentials,
    fetchImpl: Fetch = fetch,
    now: () => number = Date.now,
    warn: (message: string) => void = () => {},
  ) {
    this.#app = app;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#warn = warn;
  }

  async repos(): Promise<Repo[]> {
    const jwt = appJwt(this.#app, this.#now());
    const installations = (await this.#pages(
      `/app/installations`,
      jwt,
      (page) => page as unknown[],
    )) as {
      id: number;
    }[];
    const repos: Repo[] = [];
    const owners = new Map<string, number>();
    // One installation that cannot be read does not hide the others. If GitHub says it is
    // gone or suspended (403, 404) its repos go; if GitHub merely failed, it keeps the repos
    // it had, so a passing error does not stop the VMs waiting for its jobs.
    let failure: unknown = null;
    let read = 0;
    for (const installation of installations) {
      let found: Repo[];
      try {
        const token = await this.#installationToken(installation.id);
        const listed = (await this.#pages(
          `/installation/repositories`,
          token,
          (page) => (page as { repositories: unknown[] }).repositories,
        )) as { full_name: string; private: boolean }[];
        found = listed.map((repo) => ({ fullName: repo.full_name, private: repo.private }));
        this.#lastRead.set(installation.id, found);
        read++;
      } catch (error) {
        failure ??= error;
        const refused = error instanceof GitHubError && [403, 404].includes(error.status);
        if (refused) this.#lastRead.delete(installation.id);
        found = this.#lastRead.get(installation.id) ?? [];
        const reason = error instanceof Error ? error.message : String(error);
        this.#warn(`Could not read installation ${installation.id}: ${reason}`);
      }
      for (const repo of found) {
        owners.set(repo.fullName, installation.id);
        repos.push(repo);
      }
    }
    if (failure !== null && read === 0) throw failure;
    for (const id of [...this.#lastRead.keys()]) {
      if (!installations.some((installation) => installation.id === id)) this.#lastRead.delete(id);
    }
    this.#installations = owners;
    return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async token(repo: string): Promise<string> {
    if (!this.#installations.has(repo)) await this.repos();
    const installation = this.#installations.get(repo);
    if (installation === undefined) throw new Error(`The GitHub App is not installed on ${repo}`);
    return this.#installationToken(installation);
  }

  async #installationToken(installation: number): Promise<string> {
    const cached = this.#tokens.get(installation);
    if (cached && cached.expiresAt - this.#now() > 5 * 60_000) return cached.token;
    // Every request of a round finds the token near its end together: they share one renewal.
    let renewal = this.#renewals.get(installation);
    if (!renewal) {
      renewal = this.#renew(installation).finally(() => this.#renewals.delete(installation));
      this.#renewals.set(installation, renewal);
    }
    return renewal;
  }

  async #renew(installation: number): Promise<string> {
    const response = await this.#fetch(`${API}/app/installations/${installation}/access_tokens`, {
      method: 'POST',
      headers: githubHeaders(appJwt(this.#app, this.#now())),
    });
    await expectOk(response, 'Getting an installation token');
    const body = (await response.json()) as { token: string; expires_at: string };
    this.#tokens.set(installation, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  async #pages(
    path: string,
    token: string,
    items: (page: unknown) => unknown[],
  ): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const response = await this.#fetch(`${API}${path}?per_page=100&page=${page}`, {
        headers: githubHeaders(token),
      });
      await expectOk(response, `GET ${path}`);
      const found = items(await response.json());
      all.push(...found);
      if (found.length < 100) break;
    }
    return all;
  }
}

/**
 * The App manifest (D03): the form the dashboard posts to GitHub, so creating the App is one
 * click. It asks for exactly what registering a runner and reading the queue need.
 */
export function appManifest(name: string, origin: string): Record<string, unknown> {
  return {
    name,
    url: 'https://minitart.rovira.sh',
    redirect_url: `${origin}/setup/callback`,
    public: false,
    // minitart polls (D02). GitHub requires a webhook URL in a manifest; this one is never
    // called, because the hook is inactive and the App subscribes to no events.
    hook_attributes: { url: 'https://minitart.rovira.sh/no-webhooks', active: false },
    default_events: [],
    default_permissions: {
      // Registering and removing a repo's self-hosted runners.
      administration: 'write',
      // Reading workflow runs, jobs and their logs.
      actions: 'read',
      metadata: 'read',
    },
  };
}

/** Trades the code GitHub sends back from the manifest form for the new App's credentials. */
export async function convertManifestCode(
  code: string,
  fetchImpl: Fetch = fetch,
): Promise<AppCredentials> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(code)) throw new Error('GitHub sent back a malformed code');
  const response = await fetchImpl(`${API}/app-manifests/${code}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'minitart' },
  });
  await expectOk(response, 'Creating the GitHub App');
  const body = (await response.json()) as {
    id: number;
    slug: string;
    pem: string;
    html_url: string;
  };
  return { appId: body.id, slug: body.slug, pem: body.pem, htmlUrl: body.html_url };
}
