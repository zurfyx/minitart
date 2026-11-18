# D07: TypeScript that Node runs as it is: no build, no runtime dependencies

Status: `PROPOSED`

## Decision

minitart is TypeScript, run by Node 24 directly from `src/` (Node strips the types). There
is no build step and no bundler. It has **no runtime dependencies**: HTTP, crypto, child
processes and the test runner are Node's own. The dashboard is plain HTML, CSS and one
script.

`tsc` only checks (`noEmit`, `erasableSyntaxOnly`). Imports name the `.ts` file.

## Why

The pitch is that minitart is small enough to read, and it holds a credential with
administration rights on the owner's repos. Every dependency would be code the owner did not
read running next to that credential. The work is a handful of REST calls, one JWT, a few
child processes and one page; the standard library covers it.

TypeScript rather than Go or Swift because it is what the owner's other projects are written
in, with the same tools (pnpm, Prettier, ESLint, strict TypeScript).

## Consequences

- Node 24 or newer on the Mac.
- No enums, parameter properties or namespaces: only syntax that can be erased.
- Development dependencies (TypeScript, ESLint, Prettier) do not run on the Mac that serves
  jobs.
- The dashboard has no framework. If it outgrows one file, that is a new decision.
