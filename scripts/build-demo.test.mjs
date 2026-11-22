import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from './build-demo.mjs';

const out = mkdtempSync(join(tmpdir(), 'minitart-demo-'));
after(() => rmSync(out, { recursive: true, force: true }));

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('the demo builds into modules a browser can load, with nothing of Node left', async () => {
  const { modules } = build(out);
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
  assert.match(page, /A demo: a made-up Mac/);
});
