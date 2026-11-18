# minitart

A very small manager for GitHub Actions runners on the owner's own Mac mini: every job runs
in a fresh Tart VM that reaches the internet and nothing private, and is deleted when the
job ends. One Node process (the manager and its dashboard) and one static website. It is
public, and it holds a credential with administration rights on its owner's repos, so
smallness and the security model come before features.

## Read before working

- `docs/product.md`: what minitart is and what it promises (authoritative product intent)
- `docs/architecture.md`: the system shape: the life of a job, the parts, the GitHub calls
- `docs/security.md`: what a job can and cannot do, and what is not covered. **A change
  that touches a row of its table changes the table in the same pull request.**
- `docs/setup.md`: setting a Mac up, step by step. A change to a command, a flag or what
  `doctor` prints changes this file in the same pull request.
- `docs/release.md`: how a push to `main` becomes a release and reaches the Homebrew tap
- `docs/design.md`: the look of the dashboard and the site, and the rules it follows
- `docs/testing.md`: the test layers, and what can only be tested on the Mac
- `docs/decisions/README.md`: **the decision register.** Every consequential choice lives
  here with status and blast radius. `DECIDED` rows are not re-litigated without new
  evidence. When you make a new consequential decision, add a row and its file in the same
  commit.

## Layout

```
src/         the manager: TypeScript that Node runs as it is (D07)
dashboard/   the page the manager serves: plain HTML, CSS and one script
images/      the scripts that turn an upstream image into a job image (D11)
firewall/    the pf rule that keeps a VM off the Mac's own services, and its removal (D21)
Formula/     the Homebrew formula's template; a release fills in its version (D16)
site/        minitart.rovira.sh, one static page (D15)
docs/        product, architecture, security, design, testing, and the decision register
scripts/     repo tooling, with its tests
```

## Commands

```bash
pnpm install          # development tools only; minitart itself has no dependencies
pnpm demo             # the dashboard with made-up jobs and VMs, at 127.0.0.1:4141
pnpm start            # the real manager
pnpm typecheck        # strict TS (tsc, no emit): must pass before every commit
pnpm lint             # ESLint
pnpm format:check     # Prettier
pnpm test             # node --test over src/**/*.test.ts and scripts/**/*.test.mjs
node src/main.ts doctor [--fix] | upgrade | drain | resume | selftest | image build <kind> | service install
node scripts/release.mjs plan   # what a push to main would release (docs/release.md)
```

## Conventions

- **No runtime dependencies** (D07). `dependencies` in `package.json` stays empty; reach for
  Node's standard library. A development dependency needs a reason.
- **Only erasable TypeScript** (D07): no enums, parameter properties or namespaces. Imports
  name the `.ts` file.
- **The security rules are code rules** (D01, D03, D04):
  - A VM is started only through `src/tart.ts`, which never passes `--dir` and always passes
    the network it was given. No code path shares a folder with a VM.
  - The App's key is used only in `src/github/app.ts`, to sign. `src/main.ts` loads and
    saves it; it goes nowhere else: not into a VM, a log, a response or an error message.
  - A runner's config reaches the guest on standard input, never as an argument.
  - Everything from outside is untrusted: request bodies, `settings.json`, and every name
    that comes from GitHub (jobs, workflows, repos). Validate, never coerce; write to the
    page as text, never HTML; pass to `tart` as arguments, never through a shell.
  - The dashboard listens on 127.0.0.1 and refuses any other connection (D10). It answers
    to `127.0.0.1`, `localhost`, and the tailnet names Tailscale Serve forwards to it,
    never to one Funnel publishes (D20). No flag or setting adds a name.
  - A repo is served only when the App is installed on it and it is in `settings.repos`
    (D03). A fresh install serves nothing.
- **Tests use the fakes**, not mocks of modules: `src/testing/fakes.ts` is a GitHub and a
  Tart in memory, and the manager is tested whole against them (`docs/testing.md`).
- **Every feature ships with tests**, and anything security-relevant gets a test that names
  the rule it holds.
- **Design**: colours, fonts and radii come from `dashboard/tokens.css`; `site/tokens.css`
  is a copy and a test keeps them identical. No raw colours elsewhere. A state is a glyph
  and a word in the state's colour, never the colour alone. Motion only on a change of
  state (`docs/design.md`).
- **Docs are rewritten, never amended** (D14): when reality changes, rewrite the doc to read
  as if written fresh today. Git is the changelog.
- **Names in examples and tests are made up** (`octo/app`). The owner's private repo names
  do not appear in this public repo.
- Workflow (D12): branch per unit of work (`feat/`, `fix/`, `docs/`, `chore/`), PR to
  `main`, never commit to `main` directly. The owner reviews every PR and squash-merges it
  himself: open the PR and stop there. Commits: concise imperative subject, authored by the
  repo owner, no AI trailers. PR descriptions carry no AI attribution either.
- **Versions are not edited** (D16). `package.json` and `Formula/minitart.rb` say `0.0.0`
  and stay that way; a release takes the next patch number by itself. A change to what
  ships (`src/`, `dashboard/`, `images/`, `firewall/`, `package.json`) is released when it
  reaches `main`: it must be fit to run on the owner's Mac the moment it merges.
- Never deploy by hand (D15). Vercel deploys the website on pushes to `main`. No deploy
  secret is stored in GitHub.
- Workflows: every action pinned to a full commit sha with a version comment, `contents:
read` permissions, checkouts with `persist-credentials: false`. The `zizmor` CI job must
  stay clean. CI runs on GitHub's hosted runners, never on minitart (D05).

## Before a PR

CI has no AI in it. It checks that you did these and wrote them down (D13); it cannot check
that you did them well.

1. **Look at it.** Run what you changed and look at the result: `pnpm demo` for the
   dashboard, `site/index.html` for the website, in light and dark, at 1440px and 390px
   wide. Put the screenshots in the PR. A change nobody can see says so:
   `No visual change: <reason>`.
2. **Have it reviewed.** Run a code review on the final diff (`/code-review` in Claude Code,
   or a fresh agent that has not seen your reasoning). Fix each finding or answer it in the
   PR.
3. **Test it.** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (the
   pre-push hook runs them). A change to how VMs start, to the network or to the images is
   also run on the Mac: `docs/testing.md`, layer 3. Say in the PR what you ran.
4. **Fill in the PR template**, tick its boxes, and set `Verified at:` to the head commit you
   verified.

**After every amendment, do it again.** A new push makes the `pr-checklist` job fail until
`Verified at:` names the new head commit. Update it only after looking and reviewing again.

Machine-specific notes go in `AGENTS.local.md`, which is gitignored.
