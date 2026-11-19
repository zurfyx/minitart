// Scenarios ported from the test suites of similar projects: the GitHub REST client and the
// App's tokens when GitHub fails, pages, limits, or answers with something unexpected.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { AppAuth } from './github/app.ts';
import { GitHubClient, type Fetch } from './github/client.ts';
import { GitHubError } from './github/types.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const app = { appId: 42, slug: 'minitart-mini', pem, htmlUrl: 'https://github.com/apps/x' };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a table of `METHOD path` and records what it was asked. */
function fakeFetch(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init = {}) => {
    const call = {
      method: init.method ?? 'GET',
      url,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const path = url.replace('https://api.github.com', '').replace(/\?.*$/, '');
    const route = routes[`${call.method} ${path}`];
    if (!route) return Response.json({ message: 'Not Found' }, { status: 404 });
    return route(call);
  };
  return { fetch, calls };
}

const auth = { repos: async () => [], token: async () => 'ghs_x' };
const page = (url: string) => Number(new URL(url).searchParams.get('page'));
const runs = (count: number, from = 0) => ({
  workflow_runs: Array.from({ length: count }, (_, i) => ({ id: from + i })),
});

// After runscaler cmd/runner/listener_backoff_test.go: TestListenerBackoffWaitsOutRateLimits
test('a secondary rate limit says when to come back through Retry-After', async () => {
  const { fetch } = fakeFetch({
    'GET /repos/octo/app/actions/runs': () =>
      Response.json(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 403, headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4000' } },
      ),
  });
  const before = Date.now();
  await assert.rejects(new GitHubClient(auth, fetch).activeRuns('octo/app'), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.ok(error.retryAt !== null);
    assert.ok(error.retryAt >= before + 60_000 && error.retryAt <= Date.now() + 60_000);
    assert.match(error.message, /secondary rate limit/);
    return true;
  });
});

// After ephemerd pkg/scheduler/retry_queue_test.go: TestRetryQueue_NonRetryableErrorNotEnqueued
test('a refusal that is not a rate limit carries no time to come back', async () => {
  const { fetch } = fakeFetch({
    'POST /repos/octo/app/actions/runners/generate-jitconfig': () =>
      Response.json(
        { message: 'Resource not accessible by integration' },
        { status: 403, headers: { 'x-ratelimit-remaining': '4999' } },
      ),
  });
  await assert.rejects(
    new GitHubClient(auth, fetch).registerRunner('octo/app', 'minitart-linux-0a1b2c', []),
    (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 403);
      assert.equal(error.retryAt, null);
      assert.match(error.message, /Resource not accessible by integration/);
      return true;
    },
  );
});

// After ephemerd pkg/github/jobawaiting_test.go: TestJobAwaitingRunner_ServerErrorIsUnknown
test('an answer cut short is an error, never an empty queue', async () => {
  const { fetch } = fakeFetch({
    'GET /repos/octo/app/actions/runs/9/jobs': () =>
      new Response('{"total_count":3,"jobs":[{"id":1,', {
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(new GitHubClient(auth, fetch).jobs('octo/app', 9));
});

// After runscaler internal/regsweep/sweep_test.go: TestSweepReadsEveryPage
test('a list of exactly one page asks for the next, and a list never ends is read to ten pages', async () => {
  const exact = fakeFetch({
    'GET /repos/octo/app/actions/runs': (call) =>
      Response.json(runs(page(call.url) === 1 ? 100 : 0)),
  });
  // Five statuses, each one full page and one empty one; then the unfiltered newest page.
  assert.equal((await new GitHubClient(auth, exact.fetch).activeRuns('octo/app')).length, 100);
  assert.equal(exact.calls.length, 11);

  const endless = fakeFetch({
    'GET /repos/octo/app/actions/runs': (call) =>
      Response.json(runs(100, (page(call.url) - 1) * 100)),
  });
  const ids = await new GitHubClient(auth, endless.fetch).activeRuns('octo/app');
  assert.equal(ids.length, 1000);
  assert.equal(Math.max(...endless.calls.map((call) => page(call.url))), 10);
});

// After ephemerd pkg/github/runnerbusy_test.go: TestRunnerBusy_ErrorIsNotAnAnswer
test('removing a runner GitHub says is busy fails; one GitHub no longer knows is already gone', async () => {
  const { fetch } = fakeFetch({
    'DELETE /repos/octo/app/actions/runners/7': () =>
      Response.json(
        { message: 'Bad request - Runner "x" is still running a job"' },
        { status: 422 },
      ),
  });
  const client = new GitHubClient(auth, fetch);
  await assert.rejects(client.removeRunner('octo/app', 7), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 422);
    return true;
  });
  await client.removeRunner('octo/app', 8);
});

// After ephemerd pkg/github/rate_transport_test.go: TestRateTrackingTransport_NoHeaders_LeavesSnapshotAlone
test('a failed read keeps the cached answer, which an unchanged reply then serves', async () => {
  let failing = false;
  const { fetch, calls } = fakeFetch({
    'GET /repos/octo/app/actions/runs/9/jobs': (call) => {
      if (failing) return new Response(null, { status: 500 });
      if (call.headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
      return Response.json(
        { jobs: [{ id: 5, run_id: 9, name: 'test', status: 'queued', created_at: 'x' }] },
        { headers: { etag: '"v1"' } },
      );
    },
  });
  const client = new GitHubClient(auth, fetch);
  assert.equal((await client.jobs('octo/app', 9)).length, 1);
  failing = true;
  await assert.rejects(client.jobs('octo/app', 9));
  failing = false;
  assert.equal((await client.jobs('octo/app', 9))[0]?.id, 5);
  assert.equal(calls.at(-1)?.headers['if-none-match'], '"v1"');
});

// After ephemerd pkg/github/appauth_test.go: TestExchangeToken_Non201
test('an installation token GitHub refuses is an error that names the status and not the key', async () => {
  const { fetch } = fakeFetch({
    'GET /app/installations': () => Response.json([{ id: 7 }]),
    'POST /app/installations/7/access_tokens': () =>
      Response.json({ message: 'A JSON web token could not be decoded' }, { status: 401 }),
  });
  const appAuth = new AppAuth(app, fetch, () => Date.parse('2026-11-18T10:00:00Z'));
  await assert.rejects(appAuth.repos(), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 401);
    assert.match(error.message, /installation token failed \(401\)/);
    assert.ok(!error.message.includes('PRIVATE KEY'));
    assert.ok(!error.message.includes(pem.slice(40, 80)));
    return true;
  });
});

// After ephemerd pkg/github/api_test.go: TestPollJobs_OrgLevel_DiscoverReposAndJobs
test('each repo is reached with the token of the installation it belongs to', async () => {
  const { fetch, calls } = fakeFetch({
    'GET /app/installations': () => Response.json([{ id: 7 }, { id: 8 }]),
    'POST /app/installations/7/access_tokens': () =>
      Response.json({ token: 'ghs_seven', expires_at: '2026-11-18T11:00:00Z' }),
    'POST /app/installations/8/access_tokens': () =>
      Response.json({ token: 'ghs_eight', expires_at: '2026-11-18T11:00:00Z' }),
    'GET /installation/repositories': (call) =>
      Response.json({
        repositories:
          call.headers['authorization'] === 'Bearer ghs_seven'
            ? [{ full_name: 'octo/app', private: true }]
            : [{ full_name: 'acme/api', private: true }],
      }),
    'GET /repos/acme/api/actions/runs': () => Response.json({ workflow_runs: [] }),
  });
  const appAuth = new AppAuth(app, fetch, () => Date.parse('2026-11-18T10:00:00Z'));
  assert.deepEqual(
    (await appAuth.repos()).map((repo) => repo.fullName),
    ['acme/api', 'octo/app'],
  );
  await new GitHubClient(appAuth, fetch).activeRuns('acme/api');
  const reads = calls.filter((call) => call.url.includes('/repos/acme/api/'));
  assert.equal(reads.length, 6);
  assert.ok(reads.every((call) => call.headers['authorization'] === 'Bearer ghs_eight'));
});

// After ephemerd pkg/github/api_test.go: TestPollJobs_OrgLevel_PartialRepoFailure
test('one installation that cannot be reached does not hide the repos of the others', async () => {
  const { fetch } = fakeFetch({
    'GET /app/installations': () => Response.json([{ id: 7 }, { id: 8 }]),
    'POST /app/installations/7/access_tokens': () =>
      Response.json({ message: 'This installation has been suspended' }, { status: 403 }),
    'POST /app/installations/8/access_tokens': () =>
      Response.json({ token: 'ghs_eight', expires_at: '2026-11-18T11:00:00Z' }),
    'GET /installation/repositories': () =>
      Response.json({ repositories: [{ full_name: 'octo/app', private: true }] }),
  });
  const appAuth = new AppAuth(app, fetch, () => Date.parse('2026-11-18T10:00:00Z'));
  assert.deepEqual(
    (await appAuth.repos()).map((repo) => repo.fullName),
    ['octo/app'],
  );
});

// After ephemerd pkg/github/appauth_test.go: TestAppAuth_Token_ConcurrentRefreshSerialized
test('many requests at once that find the token near its end renew it once', async () => {
  let now = Date.parse('2026-11-18T10:00:00Z');
  let issued = 0;
  const { fetch } = fakeFetch({
    'GET /app/installations': () => Response.json([{ id: 7 }]),
    'POST /app/installations/7/access_tokens': async () => {
      issued++;
      await new Promise((resolve) => setImmediate(resolve));
      return Response.json({
        token: `ghs_${issued}`,
        expires_at: new Date(now + 3600_000).toISOString(),
      });
    },
    'GET /installation/repositories': () =>
      Response.json({ repositories: [{ full_name: 'octo/app', private: true }] }),
  });
  const appAuth = new AppAuth(app, fetch, () => now);
  await appAuth.repos();
  assert.equal(issued, 1);
  now += 56 * 60_000;
  await Promise.all(Array.from({ length: 8 }, () => appAuth.token('octo/app')));
  assert.equal(issued, 2);
});
