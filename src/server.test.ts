import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppCredentials } from './github/app.ts';
import { Manager } from './manager.ts';
import { createDashboardServer, isLoopback } from './server.ts';
import { defaultSettings } from './settings.ts';
import type { TailnetName } from './tailnet.ts';
import { FakeGitHub, FakeTart, SERVED } from './testing/fakes.ts';
import { MemoryHistory } from './history.ts';

const machine = { cpus: 15, memoryBytes: 64 * 1024 ** 3 };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function setup(
  options: { local?: boolean; app?: AppCredentials | null; tailnet?: TailnetName[] } = {},
) {
  const github = new FakeGitHub();
  github.repoList = [{ fullName: 'octo/app', private: true }];
  const tart = new FakeTart();
  tart.addImage('minitart-base-linux');
  const manager = new Manager({
    github: () => github,
    tart,
    network: 'softnet',
    settings: { ...defaultSettings(machine), repos: SERVED },
    saveSettings: () => {},
    history: new MemoryHistory(),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
  let app = options.app ?? null;
  const port = await freePort();
  const conversions: string[] = [];
  const server = createDashboardServer({
    manager,
    github: () => github,
    app: () => app,
    saveApp: (created) => (app = created),
    health: () => [],
    resources: () => ({
      stepMs: 10_000,
      cores: 8,
      memoryBytes: 16 * 1024 ** 3,
      points: [{ at: 1, cpuVms: 20, cpuOther: 5, memVms: 4096, memOther: 2048 }],
      disk: null,
    }),
    machine,
    port,
    dashboardDir: fileURLToPath(new URL('../dashboard/', import.meta.url)),
    isLocal: () => options.local ?? true,
    tailnet: () => options.tailnet ?? [],
    fetch: async (url) => {
      conversions.push(url);
      return Response.json({
        id: 42,
        slug: 'minitart-mini',
        pem: 'KEY MATERIAL',
        html_url: 'https://github.com/apps/minitart-mini',
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  after(() => server.close());
  const origin = `http://127.0.0.1:${port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
    });
  return { origin, port, manager, github, tart, post, conversions, app: () => app };
}

test('only loopback addresses are the Mac itself', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('100.64.0.7'));
  assert.ok(!isLoopback('192.168.1.20'));
  assert.ok(!isLoopback(undefined));
});

test('the page and its state are served, with a policy that allows no outside script', async () => {
  const { origin } = await setup();
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  assert.match(await page.text(), /<title>minitart<\/title>/);
  for (const path of [
    '/app.js',
    '/charts.js',
    '/view.js',
    '/style.css',
    '/tokens.css',
    '/favicon.svg',
  ]) {
    assert.equal((await fetch(`${origin}${path}`)).status, 200, path);
  }
  // The app's manifest and icons, as what they are: a browser installs it from these.
  for (const [path, type] of [
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/favicon.ico', 'image/x-icon'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type, path);
  }
  assert.equal(
    (await fetch(`${origin}/icons/app-icon.svg`)).status,
    404,
    'the source is not served',
  );
  // The tests beside the page are not part of it.
  assert.equal((await fetch(`${origin}/view.test.mjs`)).status, 404);
  // The Jobs view's pages, checked before they reach the history.
  const jobs = (await (await fetch(`${origin}/api/jobs?page=1&result=failure`)).json()) as {
    total: number;
    pages: number;
    per: number;
  };
  assert.deepEqual([jobs.total, jobs.pages, jobs.per], [0, 1, 50]);
  for (const bad of [
    'page=0',
    'page=1.5',
    'page=x',
    'repo=..%2Fx',
    'repo=a',
    'result=DROP%20TABLE',
  ]) {
    assert.equal((await fetch(`${origin}/api/jobs?${bad}`)).status, 400, bad);
  }
  const storage = (await (await fetch(`${origin}/api/storage`)).json()) as { keepDays: number };
  assert.equal(storage.keepDays, 365);
  const resources = (await (await fetch(`${origin}/api/resources`)).json()) as {
    points: unknown[];
  };
  assert.equal(resources.points.length, 1);
  const state = (await (await fetch(`${origin}/api/state`)).json()) as Record<string, unknown>;
  assert.equal(state['app'], null);
  assert.equal((await fetch(`${origin}/../../etc/passwd`)).status, 404);
});

test('a request under another host name is refused', async () => {
  const { port } = await setup();
  // What a DNS-rebinding page would send: this server's address under its own name.
  const raw = await new Promise<string>((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `GET /api/state HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
  });
  assert.match(raw, /^HTTP\/1\.1 421/);
});

test('settings change from the Mac, same origin, as JSON, and are validated', async () => {
  const { post, manager } = await setup();
  assert.equal((await post({ linux: { max: 3 } })).status, 200);
  assert.equal(manager.settings.linux.max, 3);

  assert.equal((await post({ linux: { max: 1 } }, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ linux: { max: 1 } }, { 'content-type': 'text/plain' })).status, 415);
  const refused = await post({ macos: { max: 3 } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /macos\.max/);
  assert.equal(manager.settings.linux.max, 3);
});

test('a connection that is not from this Mac gets nothing', async () => {
  const { origin, post, manager } = await setup({ local: false });
  assert.equal((await fetch(`${origin}/`)).status, 403);
  assert.equal((await fetch(`${origin}/api/state`)).status, 403);
  assert.equal((await fetch(`${origin}/api/events`)).status, 403);
  assert.equal((await post({ linux: { max: 3 } })).status, 403);
  assert.equal(manager.settings.linux.max, defaultSettings(machine).linux.max, 'unchanged');
  assert.equal((await fetch(`${origin}/setup/manifest`)).status, 403);
});

test('creating the GitHub App: the manifest, then the callback with the same state', async () => {
  const { origin, conversions, app } = await setup();
  const { action, manifest } = (await (await fetch(`${origin}/setup/manifest`)).json()) as {
    action: string;
    manifest: string;
  };
  const state = new URL(action).searchParams.get('state') ?? '';
  assert.match(action, /^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{48}$/);
  assert.equal(
    (JSON.parse(manifest) as { redirect_url: string }).redirect_url,
    `${origin}/setup/callback`,
  );

  // A page on another site cannot start the round trip.
  const crossSite = await fetch(`${origin}/setup/manifest`, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);

  const forged = await fetch(`${origin}/setup/callback?code=abc&state=${'0'.repeat(48)}`);
  assert.equal(forged.status, 400);
  assert.deepEqual(conversions, [], 'a callback with the wrong state trades no code');

  // The forged attempt cancelled nothing: the real callback still works, once.
  const done = await fetch(`${origin}/setup/callback?code=abc&state=${state}`, {
    redirect: 'manual',
  });
  assert.equal(done.status, 302);
  assert.equal(
    done.headers.get('location'),
    'https://github.com/apps/minitart-mini/installations/new',
  );
  assert.equal(app()?.appId, 42);
  const replay = await fetch(`${origin}/setup/callback?code=abc&state=${state}`, {
    redirect: 'manual',
  });
  assert.equal(replay.status, 400, 'the state is single-use');
  assert.equal(
    (await fetch(`${origin}/setup/manifest`)).status,
    409,
    'an App is never overwritten',
  );

  const shown = await (await fetch(`${origin}/api/state`)).text();
  assert.ok(!shown.includes('KEY MATERIAL'), 'the key is never sent to the page');
  assert.match(shown, /"slug":"minitart-mini"/);
});

test('logs: a VM by its exact name, a job only if minitart ran it', async () => {
  const { origin, manager, github, tart } = await setup();
  const job = github.queue('octo/app', ['minitart-linux'], 'test');
  await manager.tick();
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  const [name] = tart.runners();
  assert.ok(name);
  github.take(name);
  tart.print(name, 'Running job: test');
  await manager.tick();
  assert.match(await (await fetch(`${origin}/api/vms/${name}/log`)).text(), /Running job: test/);
  assert.equal((await fetch(`${origin}/api/vms/minitart-linux-ffffff/log`)).status, 404);
  assert.equal((await fetch(`${origin}/api/vms/..%2Fapp.json/log`)).status, 404);

  github.logs.set(job.id, 'the job log');
  github.logs.set(999, 'a log of some other job');
  assert.equal(await (await fetch(`${origin}/api/jobs/${job.id}/log`)).text(), 'the job log');
  assert.equal((await fetch(`${origin}/api/jobs/999/log`)).status, 404);
  await manager.stop();
});

/** A request as Tailscale Serve forwards it: from this Mac, under the tailnet name. */
function viaTailscale(port: number, host: string, request: string): Promise<string> {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(request.replace('{host}', host));
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
    });
  });
}

test('the tailnet gets the same dashboard, at the name Tailscale forwards', async () => {
  const name = {
    host: 'minitart.example.ts.net',
    origin: 'https://minitart.example.ts.net',
    service: 'svc:minitart',
    refused: null,
    fix: null,
  };
  const { port, manager } = await setup({ tailnet: [name] });
  const get = (path: string, host = name.host) =>
    viaTailscale(port, host, `GET ${path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n`);
  assert.match(await get('/'), /^HTTP\/1\.1 200/);
  assert.match(await get('/api/state'), /^HTTP\/1\.1 200/);
  assert.match(await get('/', 'someone-else.example.ts.net'), /^HTTP\/1\.1 421/);

  // The same access as at the Mac: settings change from there, under its own https origin.
  const body = JSON.stringify({ idleSeconds: 240 });
  const post = (origin: string) =>
    viaTailscale(
      port,
      name.host,
      `POST /api/settings HTTP/1.1\r\nHost: {host}\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
    );
  assert.match(await post('http://minitart.example.ts.net'), /^HTTP\/1\.1 403/);
  assert.match(await post('https://evil.example'), /^HTTP\/1\.1 403/);
  assert.match(await post(name.origin), /^HTTP\/1\.1 200/);
  assert.equal(manager.settings.idleSeconds, 240);

  // Creating the GitHub App from there sends GitHub back to the tailnet name.
  const manifest = await get('/setup/manifest');
  assert.ok(manifest.includes('https://minitart.example.ts.net/setup/callback'));
});

test('a name with something against it is never answered to', async () => {
  for (const refused of ['funnel', 'plain-http'] as const) {
    const name = {
      host: 'mini.example.ts.net:8443',
      origin: 'https://mini.example.ts.net:8443',
      service: null,
      refused,
      fix: null,
    };
    const { port } = await setup({ tailnet: [name] });
    const response = await viaTailscale(
      port,
      name.host,
      'GET /api/state HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n',
    );
    assert.match(response, /^HTTP\/1\.1 421/, refused);
  }
});

test('what Funnel brings in from the internet is refused, whatever the names say', async () => {
  // Funnel was switched on a moment ago, and the names have not been read again yet.
  const name = {
    host: 'minitart.example.ts.net',
    origin: 'https://minitart.example.ts.net',
    service: null,
    refused: null,
    fix: null,
  };
  const { port } = await setup({ tailnet: [name] });
  const get = (extra: string, host = name.host) =>
    viaTailscale(
      port,
      host,
      `GET /api/state HTTP/1.1\r\nHost: {host}\r\n${extra}Connection: close\r\n\r\n`,
    );
  assert.match(await get(''), /^HTTP\/1\.1 200/);
  assert.match(await get('Tailscale-Funnel-Request: ?1\r\n'), /^HTTP\/1\.1 421/);
  assert.match(
    await get('Tailscale-Funnel-Request: ?1\r\n', `127.0.0.1:${port}`),
    /^HTTP\/1\.1 421/,
  );
});
