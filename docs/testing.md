# Testing

Three layers. The first two run everywhere, on every push. The third needs this Mac.

## 1. Unit tests: `pnpm test`

`node --test` over `src/**/*.test.ts` and `scripts/**/*.test.mjs`. No VM, no network.

The files named `src/prior-art.*.test.ts` hold scenarios taken from the test suites of the
projects that did this before: Runscaler, ephemerd, Sand, Graftery, KnobanLabs'
macos-ephemeral-runners, Cirrus CLI and Cilicon. Each is rewritten against minitart's own
fakes, with a comment naming the test it comes from. They are what other people's bugs look
like here: a runner that exits before it connects, a repo turned off while its job runs, one
unreachable installation among several.

The manager is tested whole, against a GitHub and a Tart that live in memory
(`src/testing/fakes.ts`): a job is queued, a VM appears, the runner takes the job, the VM is
deleted. The fakes are driven by hand, with a clock the test owns, so every case is
deterministic: a job that ends between two polls, a VM that never boots, a failed poll, a
rate limit, a public repo, a full pool, leftovers from a crash.

What is security-relevant has a test that names it: the runner config is never an argument;
the App's key is never sent or shown; a VM always gets the network the manager was started
with; settings from a request are validated, not coerced; the dashboard refuses another
`Host`, another `Origin`, and any connection from another machine; a job log is served only for a
job minitart ran.

## 2. Static: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`

TypeScript strict, with `erasableSyntaxOnly`, since Node runs the files as they are.

## 3. On the Mac

What the fakes cannot prove: that `tart` behaves as `src/tart.ts` assumes, and that the
network is what `docs/security.md` says.

- `pnpm demo`: the dashboard with made-up jobs. Look at it in light and dark, at 1440px and
  390px wide.
- `minitart image build linux`: a real image, built in a real VM.
- `minitart selftest`: a real VM on the real network, probing what it can reach. This is the
  test of the network promise, and it has to pass on the owner's Mac, because the answer
  depends on that Mac's network.
- A real job: a workflow with `runs-on: minitart-linux` in a served repo, watched from the
  dashboard until its VM is gone from `tart list`.

Layer 3 is run by hand and recorded in the pull request that changes what it covers.

A macOS guest differs from a Linux one in ways the fakes do not model: how long it takes to
boot, DNS on Softnet, the two-VM limit, and what a job needs from the login session
(codesign, simulators). A change to how VMs start is run with both kinds.
