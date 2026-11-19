// The menu bar app's releases (D26, docs/release.md): versioned on their own, as app-vX.Y.Z,
// and made only when the app changes, so that a minitart release never waits on Apple.
//
//   node scripts/release-app.mjs plan                     publish <version> | noop, for CI
//   node scripts/release-app.mjs cask <version> <sha256>  the tap's cask, on stdout

import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Whether a changed file is part of the app a release builds. Its tests are not. */
export function appShips(file) {
  if (file.startsWith('app/Tests/')) return false;
  return file.startsWith('app/') || file === 'scripts/app.sh';
}

/** The highest `app-vX.Y.Z` among the tags, as [x, y, z], or null when there is none. */
export function highestApp(tags) {
  const versions = tags
    .map((tag) => /^app-v(\d+)\.(\d+)\.(\d+)$/.exec(tag))
    .filter((match) => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return versions.at(-1) ?? null;
}

/** What a push to main does for the app: its first release is 0.1.0, then each next patch. */
export function planApp({ tags, tagsAtHead, changedSinceLast, lastIsAncestor = true }) {
  const last = highestApp(tags);
  if (last === null)
    return { action: 'publish', version: '0.1.0', reason: 'the first app release' };
  if (!lastIsAncestor) {
    return { action: 'noop', version: '', reason: 'the newest app release is not in this history' };
  }
  if (highestApp(tagsAtHead) !== null) {
    return { action: 'noop', version: '', reason: 'this commit is already an app release' };
  }
  const shipped = changedSinceLast.filter(appShips);
  if (shipped.length === 0)
    return { action: 'noop', version: '', reason: 'the app has not changed' };
  return {
    action: 'publish',
    version: `${last[0]}.${last[1]}.${last[2] + 1}`,
    reason: `${shipped.length} app file(s) changed since app-v${last.join('.')}`,
  };
}

/** The tap's cask: the template with its version and checksum filled in. */
export function renderCask(template, version, sha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a sha256: ${sha256}`);
  let seen = 0;
  const out = template
    .split('\n')
    .filter((line) => !line.includes('Source template only'))
    .map((line) => {
      if (/^\s*version "0\.0\.0"$/.test(line)) {
        seen++;
        return line.replace('0.0.0', version);
      }
      if (/^\s*sha256 "0{64}"$/.test(line)) {
        seen++;
        return line.replace(/0{64}/, sha256);
      }
      return line;
    })
    .join('\n');
  if (seen !== 2) throw new Error('The cask template has lost its version or sha256 line');
  return out;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const tags = lines(git('tag', '--list', 'app-v*'));
    const last = highestApp(tags);
    let lastIsAncestor = true;
    if (last !== null) {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', `app-v${last.join('.')}`, 'HEAD']);
      } catch {
        lastIsAncestor = false;
      }
    }
    const result = planApp({
      tags,
      tagsAtHead: lines(git('tag', '--points-at', 'HEAD')),
      changedSinceLast:
        last === null ? [] : lines(git('diff', '--name-only', `app-v${last.join('.')}..HEAD`)),
      lastIsAncestor,
    });
    console.log(`${result.action}${result.version ? ` ${result.version}` : ''}: ${result.reason}`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `action=${result.action}\nversion=${result.version}\n`,
      );
    }
    return;
  }
  if (command === 'cask' && args.length === 2) {
    process.stdout.write(
      renderCask(readFileSync('Casks/minitart-app.rb', 'utf8'), args[0], args[1]),
    );
    return;
  }
  console.error('usage: release-app.mjs plan | cask <version> <sha256>');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
