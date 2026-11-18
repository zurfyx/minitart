# D16: minitart is installed with Homebrew, released from every green main, and upgrades itself

Status: `DECIDED`

## Decision

**Installed with Homebrew**, from the owner's tap: `brew install zurfyx/tap/minitart`. The
formula copies the source tree and adds a `minitart` command that runs it with Node. There is
still no build ([D07](D07-typescript-run-as-it-is.md)). `brew services` keeps it running. A
checkout run with `node src/main.ts` stays a supported way to run it.

Tart and Softnet are not dependencies of the formula. They are installed beside it, from
their own tap, and `doctor` checks them.

**Released by itself.** The source says version `0.0.0` and nobody edits it. Every push to
`main` that changes what ships becomes the next patch release: checked again, packed into an
archive that is the same bytes however often it is built, tagged, published. A release bot
then proposes the formula to the tap, and it merges once the tap's own CI has installed and
tested it (`docs/release.md`).

**Upgraded with `minitart upgrade`**, in this order: running jobs finish and no new one
starts (a drain); minitart, Tart and Softnet are upgraded together; `doctor --fix` puts back
what the change undid as root, asking for the Mac's password once; minitart restarts.
Softnet is kept pinned in Homebrew, so only this command replaces its binary.

## Why

A clone and `node src/main.ts` suited the first Mac and nobody else: no command on the PATH,
no versions, no way to know an update exists, and an update that killed whatever was
running. Homebrew is where the owner's other tools are, where Tart and Softnet already come
from, and it needs no build of minitart to work.

Not npm: Node does not strip types from files under `node_modules`, so publishing there
would mean the build step D07 avoids.

Tart and Softnet stay out of the formula's dependencies because Softnet needs a newer macOS
than the tap's CI runs on, and because a dependency Homebrew upgrades on its own is exactly
what loses Softnet its permission.

The password is asked for by `minitart upgrade`, at the moment of the upgrade, rather than
never. Never would take one of two things: a sudoers rule for a binary in a folder the
owner's account can write to, or a root helper that blesses whatever appears there. Either
hands root to any program running as the owner. As it is, a Softnet that has lost its
permission starts no VM, jobs wait on GitHub, and `doctor` says why.

Patch releases only, automatically, because a version nobody chooses cannot be chosen
wrongly. A new minor or major is started by tagging it by hand, once.

## Consequences

- Homebrew formulae cannot ask for a password while installing, so a plain `brew upgrade`
  of Softnet (after unpinning it) still leaves the permission to be put back:
  `minitart doctor --fix`.
- While minitart drains, queued jobs wait on GitHub. A restart ends the drain.
- The release bot is a GitHub App installed on this repo and on the tap, and its key is a
  secret of this repo's `release` environment. Without it a release is still published; the
  tap is brought up to date the next time the workflow runs with it.
- The first thing a release changes for the owner is where minitart lives:
  `/opt/homebrew/opt/minitart`, not a checkout.
