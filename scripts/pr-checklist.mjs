// The pr-checklist job (D13). CI has no AI in it, so it cannot look at a screen or review a
// diff. It checks that whoever opened the pull request says they did, in the pull request
// body, for the commit that is now its head:
//
//   1. every box under "## Before review" is ticked;
//   2. "Verified at: <sha>" names the head commit, so a new push fails until the work is
//      looked at and reviewed again;
//   3. a change under dashboard/ or site/ carries a screenshot, or "No visual change: <reason>".
//
// It is a nudge, not a lock: a pull request can edit this file.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Paths whose changes a person can see. */
const VISUAL = [/^dashboard\//, /^site\//];

/** The text of a `## Heading` section, up to the next `## ` heading. */
export function section(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Problems with a pull request body. An empty list passes. */
export function check({ body, headSha, changedFiles }) {
  const problems = [];
  // Comments in the template explain the boxes; they are not answers.
  const text = (body ?? '').replace(/<!--[\s\S]*?-->/g, '');

  const before = section(text, 'Before review');
  if (before === null) {
    problems.push('The "## Before review" section is missing. Use the pull request template.');
  } else {
    const boxes = before.split('\n').filter((line) => /^\s*[-*] \[[ xX]\]/.test(line));
    if (boxes.length === 0) {
      problems.push('"## Before review" has no checklist. Use the pull request template.');
    }
    for (const box of boxes) {
      if (/\[ \]/.test(box)) {
        problems.push(`Not ticked: ${box.replace(/^\s*[-*] \[ \]\s*/, '').trim()}`);
      }
    }
  }

  const verified = /^Verified at:[ \t]*`?([0-9a-fA-F]{7,40})`?[ \t]*$/m.exec(text);
  if (!verified) {
    problems.push(
      'No "Verified at: <sha>" line. Name the head commit you looked at and had reviewed.',
    );
  } else if (!headSha.toLowerCase().startsWith(verified[1].toLowerCase())) {
    problems.push(
      `Verified at ${verified[1]}, but the head commit is ${headSha.slice(0, 7)}. ` +
        'Look at the change and have it reviewed again, then update the line.',
    );
  }

  const visual = changedFiles.filter((file) => VISUAL.some((path) => path.test(file)));
  if (visual.length > 0) {
    const shots = section(text, 'Screenshots') ?? '';
    const hasImage = /!\[[^\]]*\]\([^)]+\)|<img\s/i.test(shots);
    const hasReason = /^No visual change:[ \t]*\S/im.test(shots);
    if (!hasImage && !hasReason) {
      problems.push(
        `This changes ${visual.length} file(s) under dashboard/ or site/. Add screenshots under ` +
          '"## Screenshots", or the line "No visual change: <reason>".',
      );
    }
  }

  return problems;
}

function main() {
  const { PR_BODY = '', HEAD_SHA, BASE_SHA, PR_AUTHOR = '' } = process.env;
  if (!HEAD_SHA || !BASE_SHA) {
    console.error('HEAD_SHA and BASE_SHA are required.');
    process.exit(2);
  }
  // Dependabot bumps the pinned actions and has nothing to look at.
  if (PR_AUTHOR === 'dependabot[bot]') {
    console.log('Dependabot pull request: nothing to check.');
    return;
  }
  const changedFiles = execFileSync('git', ['diff', '--name-only', `${BASE_SHA}...${HEAD_SHA}`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  const problems = check({ body: PR_BODY, headSha: HEAD_SHA, changedFiles });
  if (problems.length === 0) {
    console.log('The pull request says it was looked at, reviewed and tested at its head commit.');
    return;
  }
  console.error('Before review (AGENTS.md, "Before a PR"):\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
