# D26: A menu bar app, a cask that installs minitart with it, released apart and notarized

Status: `DECIDED`

## Decision

minitart has a menu bar app, **minitart**, installed with
`brew install --cask zurfyx/tap/minitart-app`. The cask depends on the `minitart` formula,
so one install sets up both; the formula alone stays the headless install it always was.

The app is a window onto the minitart on the same Mac, and nothing more:

- **The mark** in the menu bar is minitart's Mac mini with a screen rising from it, as a
  template image. The screen says how things are: a prompt, `>_`, outlined when idle;
  filled, with the number of jobs running cut out of it, when jobs run (the number on by
  default, can be turned off); an exclamation mark when the owner is needed (no job can
  start, GitHub failing, a setup step missing, short of memory, a job waiting more than ten
  minutes); a pause sign when draining; and faint when minitart is not there. Its screen is
  larger than the logo's, to hold two digits.
- **The menu** says the dashboard's headline word for word (both are held to
  `test/headline-cases.json`), lists the jobs running with how long each has run, and what
  waits. Open Dashboard, Drain or Resume, Copy Tailnet Address, Settings (the count, open at
  login), Quit.
- **When minitart is not there**, it says so and helps: Install minitart (Terminal), Start
  minitart (its own service, or `brew services start` for Homebrew's), and Upgrade in
  Terminal for a minitart older than the app. **When a setup step is missing**, Finish setup
  in Terminal (`minitart doctor --fix`, for the steps that need the Mac's password, which
  the app never asks for itself).
- **It reads** `GET /api/state` every three seconds and acts through `POST /api/drain`. Its
  settings are the count and opening at login; minitart's own settings stay in the
  dashboard.

It watches this Mac only, `127.0.0.1:4141`. Watching another Mac is the tailnet dashboard's
job (D20).

## How it is built and released

- `app/`: a Swift package (SwiftUI, macOS 14 or later, Apple silicon), no Xcode project.
  `MinitartCore` holds what is shown, without AppKit, and is tested with `swift test`.
- `scripts/app.sh [version]` builds `minitart.app` and zips it: signed for the machine only,
  or, with `APP_SIGN_IDENTITY`, with the Developer ID certificate and the hardened runtime.
- `.github/workflows/release-app.yml`: on a push to main that changes the app, on GitHub's
  macOS runners, it tests, signs, notarizes with Apple (an automated check, usually minutes,
  no review), staples, and publishes `app-vX.Y.Z`, never as the repo's latest release. The
  release bot then updates `Casks/minitart-app.rb` in the tap. The app has its own version:
  a minitart release never waits on Apple.
- The secrets live in the `release-app` environment: the Developer ID certificate and its
  password, and an App Store Connect API key with the Developer role, for notarization only.
  Signing never happens on minitart's own runner.
- `minitart upgrade` upgrades the app with the rest when its cask is installed. The app
  needs a minitart that says its version (0.1.20 and later), and says so otherwise.

## Why

The owner wanted to see at a glance, on the Mac that runs the jobs, that minitart is there,
whether it is busy, and when it needs them. A badge on the installed dashboard's Dock icon
was proposed and turned down: a count is not a notification.

Packaging follows Tailscale's `tailscale-app` cask: one install gives everything. Unlike
Tailscale, only one Mac runs minitart, so the app is a companion of the formula on that Mac,
not a client for several; and it is a cask, since a prebuilt, notarized app is what casks
are for. The Mac App Store is not used: its sandbox would not let the app start minitart's
service, and its review is a delay with nothing gained.

## Consequences

- The owner's Apple Developer membership matters: notarization stops if it lapses.
- The Developer ID certificate lasts five years and is the account's for every Mac app; the
  release warns in its last thirty days.
- The menu bar app is the one part of minitart that is compiled. minitart itself stays
  TypeScript that Node runs as it is (D07).
