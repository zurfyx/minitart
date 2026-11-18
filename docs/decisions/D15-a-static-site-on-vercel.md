# D15: minitart.rovira.sh is one static page, on Vercel

Status: `DECIDED`

## Decision

The website is `site/`: one HTML page, one stylesheet, images. No framework and no build.
Vercel serves the folder (`vercel.json`) and deploys every push to `main`; pull requests get
a preview. It uses the dashboard's tokens (`site/tokens.css` is a copy of
`dashboard/tokens.css`, kept identical by a test).

## Why

The site says what minitart is, shows the dashboard and links to the repo. A page that does
that needs no generator. If the docs outgrow the repo's Markdown, a docs site is a new
decision.

## Consequences

- No deploy secret is stored in GitHub: Vercel's Git integration deploys.
- The screenshots on the page are taken from `pnpm demo` and committed.
