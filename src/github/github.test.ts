import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  AppAuth,
  appIdentity,
  appJwt,
  appManifest,
  convertManifestCode,
  parseAppCredentials,
} from './app.ts';
import { GitHubClient, type Fetch } from './client.ts';
import { GitHubError } from './types.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const app = {
  appId: 42,
  slug: 'minitart-mini',
  pem,
  htmlUrl: 'https://github.com/apps/minitart-mini',
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that answers from a table of `METHOD path` and records what it was asked. */
function fakeFetch(routes: Record<string, (call: Call) => Response>): {
  fetch: Fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const path = url.replace('https://api.github.com', '').replace(/\?.*$/, '');
    const route = routes[`${call.method} ${path}`];
    if (!route) return Response.json({ message: 'Not Found' }, { status: 404 });
    return route(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { headers });

test('the App JWT is signed with the key and expires within ten minutes', () => {
  const now = Date.parse('2026-11-18T10:00:00Z');
  const [header, payload, signature] = appJwt(app, now).split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  assert.equal(claims['iss'], '42');
  assert.equal(claims['iat'], now / 1000 - 60);
  assert.ok((claims['exp'] as number) - now / 1000 <= 600);
  const valid = createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, signature, 'base64url');
  assert.ok(valid);
});

test('the allowlist is the repos the App is installed on', async () => {
  const { fetch, calls } = fakeFetch({
    'GET /app/installations': () => json([{ id: 7 }]),
    'POST /app/installations/7/access_tokens': () =>
      json({ token: 'ghs_install', expires_at: '2026-11-18T11:00:00Z' }),
    'GET /installation/repositories': () =>
      json({
        repositories: [
          { full_name: 'octo/app', private: true },
          { full_name: 'octo/api', private: true },
        ],
      }),
  });
  const auth = new AppAuth(app, fetch, () => Date.parse('2026-11-18T10:00:00Z'));
  assert.deepEqual(await auth.repos(), [
    { fullName: 'octo/api', private: true },
    { fullName: 'octo/app', private: true },
  ]);
  assert.equal(await auth.token('octo/app'), 'ghs_install');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'the token is reused');
  await assert.rejects(auth.token('octo/secret'), /not installed on octo\/secret/);
  // The key signs requests to GitHub and is never sent anywhere.
  assert.ok(calls.every((call) => !JSON.stringify(call).includes('PRIVATE KEY')));
});

test('an installation token is renewed before it expires', async () => {
  let now = Date.parse('2026-11-18T10:00:00Z');
  let issued = 0;
  const { fetch } = fakeFetch({
    'GET /app/installations': () => json([{ id: 7 }]),
    'POST /app/installations/7/access_tokens': () =>
      json({ token: `ghs_${++issued}`, expires_at: new Date(now + 3600_000).toISOString() }),
    'GET /installation/repositories': () =>
      json({ repositories: [{ full_name: 'octo/app', private: true }] }),
  });
  const auth = new AppAuth(app, fetch, () => now);
  assert.equal(await auth.token('octo/app'), 'ghs_1');
  now += 50 * 60_000;
  assert.equal(await auth.token('octo/app'), 'ghs_1');
  now += 6 * 60_000;
  assert.equal(await auth.token('octo/app'), 'ghs_2');
});

const auth = { repos: async () => [], token: async () => 'ghs_x' };

test('reads are conditional: an unchanged answer comes from the cache', async () => {
  let served = 0;
  const { fetch, calls } = fakeFetch({
    'GET /repos/octo/app/actions/runs': (call) => {
      if (call.headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
      served++;
      const status = new URL(call.url).searchParams.get('status');
      const runs = {
        requested: [],
        queued: [{ id: 1 }],
        in_progress: [{ id: 3 }, { id: 1 }],
        waiting: [],
        pending: [],
      }[status ?? ''];
      return json({ workflow_runs: runs }, { etag: '"v1"' });
    },
  });
  const client = new GitHubClient(auth, fetch);
  // Asked by status, so finished runs never crowd a waiting one out.
  assert.deepEqual(await client.activeRuns('octo/app'), [1, 3]);
  assert.deepEqual(await client.activeRuns('octo/app'), [1, 3]);
  assert.equal(served, 5, 'one request per status, then nothing new to serve');
  assert.equal(calls[5]?.headers['if-none-match'], '"v1"');
  assert.equal(calls[0]?.headers['authorization'], 'Bearer ghs_x');
});

test('a pending run is listed: its job can be queued with no runner to take it', async () => {
  // Seen on GitHub: a run that takes over its concurrency group from a cancelled run stays
  // `pending`, never `queued`, while its job is queued and labelled for a runner.
  const { fetch } = fakeFetch({
    'GET /repos/octo/app/actions/runs': (call) => {
      const status = new URL(call.url).searchParams.get('status');
      return json({ workflow_runs: status === 'pending' ? [{ id: 7 }] : [] });
    },
  });
  assert.deepEqual(await new GitHubClient(auth, fetch).activeRuns('octo/app'), [7]);
});

test('every status of a run that has not completed is asked for, and no other', async () => {
  // GitHub's statuses for a workflow run, from its REST reference. The rest are conclusions
  // of a completed run. A status missing here is a queued job nobody sees.
  const notCompleted = ['in_progress', 'pending', 'queued', 'requested', 'waiting'];
  const { fetch, calls } = fakeFetch({
    'GET /repos/octo/app/actions/runs': () => json({ workflow_runs: [] }),
  });
  await new GitHubClient(auth, fetch).activeRuns('octo/app');
  const asked = calls.map((call) => new URL(call.url).searchParams.get('status')).sort();
  assert.deepEqual(asked, notCompleted);
});

test('a list longer than a page is read to its end', async () => {
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: from + i,
      run_id: 9,
      name: `job ${from + i}`,
      status: 'queued',
      created_at: '2026-11-18T10:00:00Z',
    }));
  const { fetch, calls } = fakeFetch({
    'GET /repos/octo/app/actions/runs/9/jobs': (call) =>
      json({
        jobs: new URL(call.url).searchParams.get('page') === '1' ? page(0, 100) : page(100, 30),
      }),
  });
  const jobs = await new GitHubClient(auth, fetch).jobs('octo/app', 9);
  assert.equal(jobs.length, 130);
  assert.equal(calls.length, 2);
});

test('jobs are read into the shape the manager uses', async () => {
  const { fetch } = fakeFetch({
    'GET /repos/octo/app/actions/runs/9/jobs': () =>
      json({
        jobs: [
          {
            id: 5,
            run_id: 9,
            name: 'test',
            workflow_name: 'CI',
            labels: ['minitart-linux'],
            status: 'in_progress',
            conclusion: null,
            runner_name: 'minitart-linux-0a1b2c',
            html_url: 'https://github.com/octo/app/actions/runs/9/job/5',
            created_at: '2026-11-18T10:00:00Z',
            started_at: '2026-11-18T10:00:20Z',
            completed_at: null,
          },
          {
            id: 6,
            run_id: 9,
            name: 'deploy',
            status: 'requested',
            created_at: '2026-11-18T10:00:00Z',
            runner_name: '',
          },
        ],
      }),
  });
  const [first, second] = await new GitHubClient(auth, fetch).jobs('octo/app', 9);
  assert.equal(first?.status, 'in_progress');
  assert.equal(first?.runnerName, 'minitart-linux-0a1b2c');
  assert.equal(first?.repo, 'octo/app');
  assert.deepEqual([second?.status, second?.runnerName, second?.labels], ['pending', null, []]);
});

test('registering a runner asks for a single-use config in the default group', async () => {
  const { fetch, calls } = fakeFetch({
    'POST /repos/octo/app/actions/runners/generate-jitconfig': () =>
      json({ runner: { id: 77 }, encoded_jit_config: 'abc' }),
    'DELETE /repos/octo/app/actions/runners/77': () => new Response(null, { status: 204 }),
  });
  const client = new GitHubClient(auth, fetch);
  const runner = await client.registerRunner('octo/app', 'minitart-linux-0a1b2c', [
    'minitart-linux',
  ]);
  assert.deepEqual(runner, { runnerId: 77, jitConfig: 'abc' });
  assert.deepEqual(calls[0]?.body, {
    name: 'minitart-linux-0a1b2c',
    runner_group_id: 1,
    labels: ['minitart-linux'],
    work_folder: '_work',
  });
  await client.removeRunner('octo/app', 77);
  await client.removeRunner('octo/app', 78);
});

test('a rate limit says when to come back', async () => {
  const { fetch } = fakeFetch({
    'GET /repos/octo/app/actions/runs': () =>
      Response.json(
        { message: 'API rate limit exceeded' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1795000000' },
        },
      ),
  });
  await assert.rejects(new GitHubClient(auth, fetch).activeRuns('octo/app'), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 403);
    assert.equal(error.retryAt, 1795000000 * 1000);
    assert.match(error.message, /API rate limit exceeded/);
    return true;
  });
});

test('the manifest asks for runner administration, read access to Actions, and no events', () => {
  const manifest = appManifest('minitart-mini', 'http://127.0.0.1:4141');
  assert.deepEqual(manifest['default_permissions'], {
    administration: 'write',
    actions: 'read',
    metadata: 'read',
  });
  assert.deepEqual(manifest['default_events'], []);
  assert.equal(manifest['public'], false);
  assert.equal(manifest['redirect_url'], 'http://127.0.0.1:4141/setup/callback');
  assert.equal((manifest['hook_attributes'] as { active: boolean }).active, false);
});

test('the manifest code is traded for the App credentials', async () => {
  const { fetch, calls } = fakeFetch({
    'POST /app-manifests/abc123/conversions': () =>
      json({
        id: 42,
        slug: 'minitart-mini',
        pem,
        html_url: 'https://github.com/apps/minitart-mini',
      }),
  });
  const created = await convertManifestCode('abc123', fetch);
  assert.deepEqual(created, app);
  assert.deepEqual(parseAppCredentials(JSON.parse(JSON.stringify(created))), app);
  assert.equal(calls.length, 1);
  await assert.rejects(convertManifestCode('../../user', fetch), /malformed/);
  assert.equal(calls.length, 1, 'a malformed code is never sent');
  assert.equal(parseAppCredentials({ appId: '42' }), null);
});

test('an installation GitHub fails on for a moment keeps its repos; one GitHub refuses loses them', async () => {
  let second: 'ok' | 'failing' | 'limited' | 'suspended' = 'ok';
  const warnings: string[] = [];
  const { fetch } = fakeFetch({
    'GET /app/installations': () => json([{ id: 7 }, { id: 8 }]),
    'POST /app/installations/7/access_tokens': () =>
      json({ token: 'ghs_7', expires_at: '2026-11-18T11:00:00Z' }),
    'POST /app/installations/8/access_tokens': () =>
      second === 'ok'
        ? json({ token: 'ghs_8', expires_at: '2026-11-18T10:04:00Z' })
        : Response.json(
            { message: 'nope' },
            {
              status: second === 'failing' ? 502 : 403,
              headers: second === 'limited' ? { 'retry-after': '60' } : {},
            },
          ),
    'GET /installation/repositories': (call) =>
      json({
        repositories: [
          call.headers['authorization'] === 'Bearer ghs_7'
            ? { full_name: 'octo/app', private: true }
            : { full_name: 'acme/api', private: true },
        ],
      }),
  });
  const auth = new AppAuth(
    app,
    fetch,
    () => Date.parse('2026-11-18T10:00:00Z'),
    (text) => warnings.push(text),
  );
  const names = async () => (await auth.repos()).map((repo) => repo.fullName);
  assert.deepEqual(await names(), ['acme/api', 'octo/app']);

  second = 'failing';
  assert.deepEqual(await names(), ['acme/api', 'octo/app'], 'a passing error forgets nothing');
  assert.match(warnings[0] ?? '', /installation 8.*502/);

  // A rate limit is a 403 as well, and it passes.
  second = 'limited';
  assert.deepEqual(await names(), ['acme/api', 'octo/app']);

  second = 'suspended';
  assert.deepEqual(await names(), ['octo/app']);
  await assert.rejects(auth.token('acme/api'), /not installed/);
});

test('the App is known by what GitHub calls it now, so a rename does not leave a dead link', async () => {
  const { fetch, calls } = fakeFetch({
    'GET /app': () => json({ slug: 'minitart', html_url: 'https://github.com/apps/minitart' }),
  });
  assert.deepEqual(await appIdentity(app, fetch), {
    slug: 'minitart',
    htmlUrl: 'https://github.com/apps/minitart',
  });
  assert.match(calls[0]?.headers['authorization'] ?? '', /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);

  // The dashboard links to this address: nothing but an App's page on github.com is taken.
  for (const html_url of [
    'https://evil.example/apps/minitart',
    'javascript:alert(1)',
    'https://github.com/apps/another-app',
    7,
  ]) {
    const odd = fakeFetch({ 'GET /app': () => json({ slug: 'minitart', html_url }) });
    await assert.rejects(appIdentity(app, odd.fetch));
  }
});
