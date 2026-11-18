# D11: Images are built on the Mac from an upstream image and a readable script

Status: `PROPOSED`

## Decision

`minitart image build linux|macos` makes the image job VMs are cloned from: it clones an
upstream image (Cirrus Labs' Ubuntu and macOS base images by default, any Tart image with
`--from`), boots it, runs `images/<kind>.sh` in it, and keeps the result as
`minitart-base-<kind>`. The script installs GitHub's runner, checked against the checksum
GitHub publishes, and on Linux, Docker.

minitart publishes no images.

## Why

A published image would be a thing to maintain, to trust and to keep patched, and it would
be most of the project. A forty-line script on top of an image someone else maintains is
auditable, and the owner can add what their jobs need (Xcode, a toolchain) by starting from
another image or editing the script.

The image is built in a staging VM and replaces the old one only when the script succeeds,
so a failed build leaves a working image.

## Consequences

- The first macOS build downloads tens of gigabytes.
- Images go stale: the runner must stay recent enough for GitHub to accept it, and the OS
  needs patches. Rebuilding is one command, and is not automated.
- A job starts with what the image has, which is far less than GitHub's hosted images.
