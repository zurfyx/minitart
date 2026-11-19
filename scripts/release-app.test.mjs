import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appShips, highestApp, planApp, renderCask } from './release-app.mjs';

test('the app ships its sources and its build script, not its tests or minitart', () => {
  assert.ok(appShips('app/Sources/minitart-app/Mark.swift'));
  assert.ok(appShips('app/Package.swift'));
  assert.ok(appShips('scripts/app.sh'));
  assert.ok(!appShips('app/Tests/MinitartCoreTests/MinitartCoreTests.swift'));
  assert.ok(!appShips('src/manager.ts'));
  assert.ok(!appShips('dashboard/app.js'));
});

test('app releases are numbered apart from minitart’s', () => {
  assert.deepEqual(highestApp(['v0.1.18', 'app-v0.1.2', 'app-v0.1.10', 'app-v0.2.x']), [0, 1, 10]);
  assert.equal(highestApp(['v0.1.18']), null);
});

test('an app release is made only when the app changed, at the next patch', () => {
  assert.deepEqual(planApp({ tags: [], tagsAtHead: [], changedSinceLast: [] }).version, '0.1.0');
  const tags = ['app-v0.1.0', 'v0.1.20'];
  assert.equal(
    planApp({ tags, tagsAtHead: [], changedSinceLast: ['src/server.ts'] }).action,
    'noop',
  );
  assert.deepEqual(
    planApp({ tags, tagsAtHead: [], changedSinceLast: ['app/Sources/minitart-app/Model.swift'] }),
    {
      action: 'publish',
      version: '0.1.1',
      reason: '1 app file(s) changed since app-v0.1.0',
    },
  );
  assert.equal(
    planApp({ tags, tagsAtHead: ['app-v0.1.0'], changedSinceLast: ['app/x'] }).action,
    'noop',
  );
  assert.equal(
    planApp({ tags, tagsAtHead: [], changedSinceLast: ['app/x'], lastIsAncestor: false }).action,
    'noop',
  );
});

test('the cask template renders to the tap’s cask, and only its two identity lines change', () => {
  const template = readFileSync(new URL('../Casks/minitart-app.rb', import.meta.url), 'utf8');
  const sha = 'a'.repeat(64);
  const cask = renderCask(template, '0.1.0', sha);
  assert.match(cask, /^\s*version "0\.1\.0"$/m);
  assert.match(cask, new RegExp(`^\\s*sha256 "${sha}"$`, 'm'));
  assert.ok(!cask.includes('Source template only'));
  assert.match(cask, /depends_on formula: "zurfyx\/tap\/minitart"/);
  assert.match(cask, /releases\/download\/app-v#\{version\}\/minitart-app-#\{version\}\.zip/);
  assert.throws(() => renderCask(template, 'v1', sha));
  assert.throws(() => renderCask(template, '0.1.0', 'nope'));
});
