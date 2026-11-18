import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { check, section } from './pr-checklist.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

const body = ({ ticked = true, verified = '0123456', screenshots = '' } = {}) => `## What and why

A change.

## Before review

- [${ticked ? 'x' : ' '}] I ran it and looked at it.
- [x] A code review ran on the final diff.
- [x] Tests cover the change.

Verified at: ${verified}

## Screenshots

${screenshots}

## Review findings

None.
`;

const run = (overrides = {}) =>
  check({ body: body(), headSha: HEAD, changedFiles: ['docs/product.md'], ...overrides });

test('a filled-in body passes', () => {
  assert.deepEqual(run(), []);
});

test('an unticked box fails, and names the box', () => {
  const problems = run({ body: body({ ticked: false }) });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Not ticked: I ran it and looked at it\./);
});

test('a missing section fails', () => {
  assert.match(run({ body: 'Just words.' })[0], /Before review/);
});

test('a missing body fails', () => {
  assert.ok(run({ body: null }).length > 0);
});

test('the full sha is accepted, in backticks too', () => {
  assert.deepEqual(run({ body: body({ verified: `\`${HEAD}\`` }) }), []);
});

test('a sha that is not the head fails: a new push needs a new look', () => {
  const problems = run({ body: body({ verified: 'fedcba9' }) });
  assert.match(problems[0], /Verified at fedcba9, but the head commit is 0123456/);
});

test('a sha left inside the template comment does not count', () => {
  const problems = run({ body: body({ verified: '<!-- 0123456 -->' }) });
  assert.match(problems[0], /No "Verified at: <sha>" line/);
});

test('a change under dashboard/ needs a screenshot', () => {
  const problems = run({ changedFiles: ['dashboard/app.js'] });
  assert.match(problems[0], /Add screenshots/);
});

test('a screenshot satisfies it, as markdown or as an img tag', () => {
  const files = ['site/index.html'];
  for (const screenshots of [
    '![camp](https://example.com/a.png)',
    '<img src="a.png" width="300">',
  ]) {
    assert.deepEqual(run({ body: body({ screenshots }), changedFiles: files }), []);
  }
});

test('so does saying why there is nothing to see', () => {
  const screenshots = 'No visual change: renames a private function.';
  assert.deepEqual(run({ body: body({ screenshots }), changedFiles: ['dashboard/style.css'] }), []);
});

test('an empty reason does not', () => {
  const problems = run({
    body: body({ screenshots: 'No visual change:' }),
    changedFiles: ['dashboard/style.css'],
  });
  assert.equal(problems.length, 1);
});

test('section() stops at the next heading', () => {
  assert.equal(section('## A\none\n## B\ntwo', 'A'), 'one');
  assert.equal(section('## A\none', 'B'), null);
});

test('the pull request template has the sections the check reads', () => {
  const template = readFileSync(
    new URL('../.github/pull_request_template.md', import.meta.url),
    'utf8',
  );
  assert.notEqual(section(template, 'Before review'), null);
  assert.notEqual(section(template, 'Screenshots'), null);
  assert.match(template, /^Verified at:/m);
  // An untouched template must fail: its boxes are empty and it names no commit.
  const problems = check({ body: template, headSha: HEAD, changedFiles: [] });
  assert.ok(problems.some((problem) => problem.startsWith('Not ticked')));
  assert.ok(problems.some((problem) => problem.startsWith('No "Verified at')));
});
