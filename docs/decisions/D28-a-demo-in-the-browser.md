# D28: A demo of the dashboard, run in the visitor's browser

Status: `DECIDED`

## Decision

demo.minitart.rovira.sh shows the dashboard on a made-up Mac, the same one `minitart start
--demo` makes up. Nothing serves it but static files on Vercel: the manager, its history and
the dashboard's API run in the page, and the dashboard's requests to `/api/` are answered by
them instead of a server. Each visitor has a Mac of their own. Draining it, serving a repo or
changing a setting changes only theirs, and it is gone when they close the page.

The API's answers live in `src/api.ts`, apart from HTTP. The server (`server.ts`) still says
who may ask, and asks `api.ts` for the answer; the demo page (`src/demo-page.ts`) asks it in
the browser (`src/demo-browser.ts`, which `demo-page.ts` puts in the page). So the demo
cannot drift from what minitart serves.

`scripts/build-demo.mjs` builds it, on Vercel, into a folder of static files: the dashboard
as it is, and the demo's TypeScript with its types stripped by Node's own
`stripTypeScriptTypes`, a module a file. No bundler and no new dependency (D07). It is a
second Vercel project from the same repo, rooted at `demo/`, next to the site's (D15).

## Why

The owner wanted a way to see the dashboard without installing anything. It brings little to
those who run minitart, so it had to cost close to nothing to keep.

Run in the browser, it has no server to pay for, deploy, restart or watch, and a visitor
cannot change what another sees. Built from the same files on every push, it is never behind.

Not a server running `--demo`: every visitor would share one Mac (one presses Drain, it is
drained for all), it would need a deploy for each release, and its kept minutes grow until
it is restarted. Never on the owner's Mac mini: it runs CI, and a page served to the internet
from it widens what the security model keeps closed.

## Consequences

- What the demo page imports must run in a browser: no Node module called, only Web APIs both
  have (`crypto.getRandomValues`, `fetch`, `EventTarget`). Some files it imports also hold
  code that needs Node, such as the SQLite history; each such import of a Node module is
  pointed at a stand-in that throws if it is called. The build's tests load every module
  built, so one that calls a stand-in as it loads, or imports a name none provides, fails
  them, and an import the build cannot read stops the build. They also run the built demo
  for ten minutes of a mocked clock: VMs take jobs, jobs are kept, the charts are kept, the
  page's `fetch` and `EventSource` answer as the server does, and nothing logs an error, so
  shared code that reaches for Node while it runs fails them too.
- The page's `fetch` and `EventSource` are replaced before the dashboard starts. The
  dashboard itself is not changed for the demo.
- Creating the GitHub App is not in the demo: its made-up GitHub already has repos, so the
  page never offers it. A job's log comes from the made-up GitHub, as everything else does.
- The Vercel project builds with `../scripts/build-demo.mjs`, outside its root: Vercel's
  setting that includes files outside the root directory must stay on (it is by default).
- The demo's subdomain needs a DNS record at the domain's DNS host, pointing to Vercel.
