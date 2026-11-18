// The release tooling (D16, docs/release.md). Run by .github/workflows/release.yml; every
// step can also be run by hand.
//
//   node scripts/release.mjs plan                  what to do: publish a version, or nothing
//   node scripts/release.mjs pack <version> <dir>  the archive Homebrew installs, and its checksum
//   node scripts/release.mjs formula <version> <sha256>   the formula for the tap, on stdout
//
// The source says version 0.0.0 everywhere and nobody edits it: a release takes the next
// patch number after the highest tag, and writes it into the archive only.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** What the archive holds, and so what a change must touch to be worth a release. */
export const SHIPPED = ['src/', 'dashboard/', 'images/', 'firewall/', 'package.json'];
/** Shipped beside the code, for reading; a change to these alone releases nothing. */
const DOCS = ['README.md', 'LICENSE', 'docs'];

/** Whether a changed file is part of what a release installs. Tests are not. */
export function ships(file) {
  if (/\.test\.(ts|mjs)$/.test(file)) return false;
  return SHIPPED.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));
}

/** The highest `vX.Y.Z` among the tags, as [x, y, z], or null when there is none. */
export function highest(tags) {
  const versions = tags
    .map((tag) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag))
    .filter((match) => match !== null)
    .map((match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return versions.at(-1) ?? null;
}

/**
 * What a push to main does. The first release is 0.1.0; after that each one is the next
 * patch. A new minor or major is started by tagging it by hand, once.
 */
export function plan({ tags, tagsAtHead, changedSinceLast }) {
  const last = highest(tags);
  if (last === null) return { action: 'publish', version: '0.1.0', reason: 'the first release' };
  if (highest(tagsAtHead) !== null) {
    return { action: 'noop', version: '', reason: 'this commit is already a release' };
  }
  const shipped = changedSinceLast.filter(ships);
  if (shipped.length === 0) {
    return { action: 'noop', version: '', reason: 'nothing that ships has changed' };
  }
  return {
    action: 'publish',
    version: `${last[0]}.${last[1]}.${last[2] + 1}`,
    reason: `${shipped.length} shipped file(s) changed since v${last.join('.')}`,
  };
}

/** The tap's formula: the template with its three identity lines filled in. */
export function renderFormula(template, version, sha256) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version === '0.0.0') {
    throw new Error(`Not a version to publish: ${version}`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256) || /^0+$/.test(sha256)) {
    throw new Error('Not a SHA-256 of an archive');
  }
  const lines = {
    url: `  url "https://github.com/zurfyx/minitart/releases/download/v${version}/minitart-${version}.tar.gz"`,
    version: `  version "${version}"`,
    sha256: `  sha256 "${sha256}"`,
  };
  let seen = 0;
  const rendered = template
    .split('\n')
    // The template's note about itself does not belong in the tap.
    .filter((line) => !line.includes('Source template only'))
    .map((line) => {
      const key = /^ {2}(url|version|sha256) "/.exec(line)?.[1];
      if (key === undefined) return line;
      seen++;
      return lines[key];
    })
    .join('\n');
  if (seen !== 3) throw new Error('The formula template has lost one of its identity lines');
  return rendered;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lines(text) {
  return text.split('\n').filter(Boolean);
}

/** Stages what ships into `<dir>/minitart-<version>.tar.gz`, byte for byte the same each time. */
export function pack(version, dir, root = process.cwd()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: ${version}`);
  const name = `minitart-${version}`;
  const stage = mkdtempSync(join(tmpdir(), 'minitart-release-'));
  const tree = join(stage, name);
  mkdirSync(tree);
  try {
    for (const path of [...SHIPPED, ...DOCS]) {
      cpSync(join(root, path), join(tree, path), {
        recursive: true,
        filter: (source) => !/\.test\.(ts|mjs)$/.test(source),
      });
    }
    const manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
    // Only what running it needs: no development tools, no scripts that call them.
    delete manifest.devDependencies;
    delete manifest.scripts;
    delete manifest['lint-staged'];
    writeFileSync(
      join(tree, 'package.json'),
      `${JSON.stringify({ ...manifest, version }, null, 2)}\n`,
    );
    writeFileSync(join(tree, 'VERSION'), `${version}\n`);

    mkdirSync(dir, { recursive: true });
    const archive = join(dir, `${name}.tar.gz`);
    // No timestamps, owners or ordering that differ from one run to the next. bsdtar is on
    // macOS and on GitHub's Ubuntu runners alike.
    const files = lines(
      execFileSync('find', [name, '-type', 'f'], { cwd: stage, encoding: 'utf8' }),
    ).sort();
    for (const file of files) execFileSync('touch', ['-t', '200001010000', join(stage, file)]);
    const tar = execFileSync(
      'bsdtar',
      [
        '--format',
        'ustar',
        '--uid',
        '0',
        '--gid',
        '0',
        '--uname',
        '',
        '--gname',
        '',
        '-cf',
        '-',
        ...files,
      ],
      { cwd: stage, maxBuffer: 256 * 1024 * 1024 },
    );
    const gz = execFileSync('gzip', ['-n', '-9'], { input: tar, maxBuffer: 256 * 1024 * 1024 });
    writeFileSync(archive, gz);
    const sha256 = createHash('sha256').update(gz).digest('hex');
    writeFileSync(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
    return { archive, sha256 };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const tags = lines(git('tag', '--list', 'v*'));
    const last = highest(tags);
    const result = plan({
      tags,
      tagsAtHead: lines(git('tag', '--points-at', 'HEAD')),
      changedSinceLast:
        last === null ? [] : lines(git('diff', '--name-only', `v${last.join('.')}..HEAD`)),
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
  if (command === 'pack' && args.length === 2) {
    const { archive, sha256 } = pack(args[0], args[1]);
    console.log(`${archive}\n${sha256}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${sha256}\n`);
    return;
  }
  if (command === 'formula' && args.length === 2) {
    process.stdout.write(
      renderFormula(readFileSync('Formula/minitart.rb', 'utf8'), args[0], args[1]),
    );
    return;
  }
  console.error('usage: release.mjs plan | pack <version> <dir> | formula <version> <sha256>');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
