# D14: Docs are rewritten, never amended

Status: `DECIDED`

## Decision

When reality changes, the doc is rewritten to read as if written fresh today. No "update:",
no "previously", no dated notes, no struck-through text. Git is the changelog.

A decision that is replaced keeps its file, with status `SUPERSEDED` and the name of its
successor, because its reasoning is still worth reading.

## Why

A doc that carries its own history has to be read twice: once for what it says and once for
which parts still hold. Agents read these docs before every piece of work; they should find
what is true.
