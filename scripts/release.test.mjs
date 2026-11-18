import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { highest, pack, plan, renderFormula, ships } from './release.mjs';

test('what ships is the code and what it runs, not its tests or the docs', () => {
  for (const file of [
    'src/manager.ts',
    'dashboard/app.js',
    'images/linux.sh',
    'firewall/install.sh',
    'package.json',
  ]) {
    assert.ok(ships(file), file);
  }
  for (const file of [
    'src/manager.test.ts',
    'scripts/release.test.mjs',
    'docs/setup.md',
    'README.md',
    'site/index.html',
    '.github/workflows/ci.yml',
    'package.json.bak',
    'Formula/minitart.rb',
  ]) {
    assert.ok(!ships(file), file);
  }
});

test('the highest tag is found by number, not by spelling', () => {
  assert.deepEqual(
    highest(['v0.1.9', 'v0.1.10', 'v0.1.2', 'nightly', 'v1.0', 'v0.2.0-rc1']),
    [0, 1, 10],
  );
  assert.equal(highest(['e2e', 'v1']), null);
});

test('a release is the next patch, and only when something that ships changed', () => {
  assert.deepEqual(plan({ tags: [], tagsAtHead: [], changedSinceLast: [] }), {
    action: 'publish',
    version: '0.1.0',
    reason: 'the first release',
  });
  const tags = ['v0.1.0', 'v0.1.1'];
  assert.equal(
    plan({ tags, tagsAtHead: [], changedSinceLast: ['src/tart.ts', 'docs/setup.md'] }).version,
    '0.1.2',
  );
  assert.equal(
    plan({ tags, tagsAtHead: [], changedSinceLast: ['docs/setup.md', 'src/tart.test.ts'] }).action,
    'noop',
  );
  assert.equal(plan({ tags, tagsAtHead: ['v0.1.1'], changedSinceLast: [] }).action, 'noop');
  // A minor started by hand is carried on from.
  assert.equal(
    plan({ tags: [...tags, 'v0.2.0'], tagsAtHead: [], changedSinceLast: ['package.json'] }).version,
    '0.2.1',
  );
});

const template = readFileSync(new URL('../Formula/minitart.rb', import.meta.url), 'utf8');

test('the source formula is a 0.0.0 template that can never be installed as it is', () => {
  assert.match(template, /^ {2}version "0\.0\.0"$/m);
  assert.match(template, /^ {2}sha256 "0{64}"$/m);
  assert.throws(() => renderFormula(template, '0.0.0', 'a'.repeat(64)), /Not a version to publish/);
  assert.throws(() => renderFormula(template, '0.1.0', '0'.repeat(64)), /Not a SHA-256/);
  assert.throws(() => renderFormula(template, '0.1.0"; system "x', 'a'.repeat(64)));
  assert.throws(
    () => renderFormula(template.replace(/^ {2}sha256 .*\n/m, ''), '0.1.0', 'a'.repeat(64)),
    /identity lines/,
  );
});

test('the tap formula is the template with its three identity lines filled in', () => {
  const rendered = renderFormula(template, '0.1.4', 'a'.repeat(64));
  assert.match(
    rendered,
    /^ {2}url "https:\/\/github\.com\/zurfyx\/minitart\/releases\/download\/v0\.1\.4\/minitart-0\.1\.4\.tar\.gz"$/m,
  );
  assert.match(rendered, /^ {2}version "0\.1\.4"$/m);
  assert.match(rendered, new RegExp(`^ {2}sha256 "${'a'.repeat(64)}"$`, 'm'));
  assert.ok(!rendered.includes('Source template only'));
  // Everything else is the template's, line for line.
  const rest = (text) =>
    text
      .split('\n')
      .filter((line) => !/^ {2}(url|version|sha256) "|Source template only/.test(line));
  assert.deepEqual(rest(rendered), rest(template));
});

test('the archive holds what runs, says its version, and is the same bytes every time', () => {
  const root = new URL('..', import.meta.url).pathname;
  const first = pack('9.8.7', mkdtempSync(join(tmpdir(), 'minitart-pack-')), root);
  const second = pack('9.8.7', mkdtempSync(join(tmpdir(), 'minitart-pack-')), root);
  assert.equal(first.sha256, second.sha256);
  assert.equal(
    readFileSync(`${first.archive}.sha256`, 'utf8'),
    `${first.sha256}  minitart-9.8.7.tar.gz\n`,
  );

  const files = execFileSync('tar', ['tzf', first.archive], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  assert.ok(files.every((file) => file.startsWith('minitart-9.8.7/')));
  for (const needed of [
    'src/main.ts',
    'src/testing/fakes.ts',
    'dashboard/index.html',
    'images/macos.sh',
    'firewall/install.sh',
    'VERSION',
    'package.json',
    'docs/setup.md',
    'LICENSE',
  ]) {
    assert.ok(files.includes(`minitart-9.8.7/${needed}`), needed);
  }
  assert.ok(!files.some((file) => /\.test\.|node_modules|\.github|\/site\//.test(file)));

  const read = (name) =>
    execFileSync('tar', ['xzOf', first.archive, `minitart-9.8.7/${name}`], { encoding: 'utf8' });
  assert.equal(read('VERSION'), '9.8.7\n');
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.version, '9.8.7');
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.dependencies, undefined, 'minitart has no runtime dependencies');
});
