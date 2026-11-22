import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from './build-demo.mjs';

const out = mkdtempSync(join(tmpdir(), 'minitart-demo-'));
after(() => rmSync(out, { recursive: true, force: true }));
const { modules } = build(out);
/** A module as the page gets it: built, with stand-ins for Node's own. */
const built = (path) => import(pathToFileURL(join(out, path)).href);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('the demo builds into modules a browser can load, with nothing of Node left', async () => {
  assert.ok(modules.includes('src/api.ts') && modules.includes('src/manager.ts'));
  // What only the Mac runs never reaches the page.
  for (const file of ['src/server.ts', 'src/main.ts', 'src/tart.ts'])
    assert.ok(!modules.includes(file), file);

  for (const file of files(out).filter((path) => path.endsWith('.js'))) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /from\s*['"]node:/, `${file} imports one of Node's modules`);
    for (const [, specifier] of code.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.ok(existsSync(resolve(dirname(file), specifier)), `${file}: ${specifier}`);
    }
  }
  // Each module links, and none calls a stand-in as it loads: the page would stop at it. The
  // page's own script starts the demo and the dashboard, which need a browser, so not that one.
  for (const file of files(join(out, 'src'))) {
    if (relative(out, file) === join('src', 'demo-page.js')) continue;
    await import(pathToFileURL(file).href);
  }
  // The files the server serves are there, at the same paths.
  for (const path of ['/app.js', '/style.css', '/apple-touch-icon.png', '/icons/icon-192.png'])
    assert.ok(existsSync(join(out, path)), path);

  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(page, /src="\/src\/demo-page\.js"/);
  assert.doesNotMatch(page, /src="\/app\.js"/, 'the dashboard starts after the demo');
  assert.match(page, /A demo with simulated jobs/);
});

/** Lets what the timers started run: the demo's work is promises between them. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Moves the mocked clock on by `ms`, a second at a time, letting each second's work run. */
async function pass(t, ms) {
  for (let at = 0; at < ms; at += 1000) {
    t.mock.timers.tick(1000);
    await settle();
  }
}

test('the demo runs its made-up Mac for minutes on the stand-ins, and none is called', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => {
    const text = args.map(String).join(' ');
    // Node's own note that the build strips types with an experimental function.
    if (!text.includes('ExperimentalWarning: stripTypeScriptTypes')) errors.push(text);
  });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const { startDemo, demoEvents, demoFetch } = await built('src/demo-browser.js');

  const starting = startDemo();
  await pass(t, 1000);
  const demo = await starting;
  const kept = demo.history.stats();
  // Ten minutes: VMs are cloned, take jobs, end, and are kept, with the charts' minutes.
  let most = 0;
  for (let minute = 0; minute < 10; minute++) {
    await pass(t, 60_000);
    most = Math.max(most, demo.api.state().vms.length);
  }
  assert.ok(most > 0, 'VMs ran');
  assert.ok(demo.history.stats().entries > kept.entries, 'jobs ended and were kept');
  assert.ok(demo.history.stats().samples > kept.samples, 'the charts were kept');

  // The page's fetch: the API's answers as the server gives them; anything else goes out.
  const outside = [];
  const fetch = demoFetch(demo.api, 'https://demo.example/#now', async (input) => {
    outside.push(String(input));
    return new Response('sent');
  });
  const state = await fetch('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.headers.get('content-type'), 'application/json');
  assert.ok(Array.isArray((await state.json()).vms));
  const drained = await fetch('/api/drain', {
    method: 'POST',
    body: JSON.stringify({ draining: true }),
  });
  assert.equal((await drained.json()).draining, true);
  assert.equal((await fetch('/api/settings', { method: 'POST', body: '{' })).status, 400);
  assert.equal(
    (await fetch(new Request('https://demo.example/api/state', { method: 'PUT' }))).status,
    405,
  );
  assert.equal((await fetch('/api/nothing')).status, 404);
  const history = await fetch('/api/history?days=7');
  assert.equal((await history.json()).days, 7);
  await fetch('/style.css');
  await fetch('https://example.org/api/state');
  assert.deepEqual(outside, ['/style.css', 'https://example.org/api/state']);

  // The page's EventSource: the state at once, then after a change, and nothing once closed.
  const Events = demoEvents(demo);
  const events = new Events();
  const sent = [];
  events.onmessage = (event) => sent.push(JSON.parse(event.data));
  await pass(t, 1000);
  assert.ok(sent.length >= 1, 'the state at once');
  assert.equal(sent.at(-1).draining, true);
  await fetch('/api/drain', { method: 'POST', body: JSON.stringify({ draining: false }) });
  await pass(t, 1000);
  assert.equal(sent.at(-1).draining, false, 'and again when it changes');
  events.close();
  const count = sent.length;
  await fetch('/api/drain', { method: 'POST', body: JSON.stringify({ draining: true }) });
  await pass(t, 2000);
  assert.equal(sent.length, count, 'nothing once closed');

  const stopping = demo.stop();
  await pass(t, 5000);
  await stopping;
  assert.deepEqual(errors, [], 'nothing went wrong, and no stand-in was called');
});
