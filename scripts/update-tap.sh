#!/bin/sh
# Makes the Homebrew tap's formula match the newest release (docs/release.md).
#
# Needs GH_TOKEN, a token that can write to the tap (the release bot's), and SOURCE_REPO.
# Safe to run again at any time: a tap that is already right is left alone, and a proposal
# that is already open is picked up where it was.
set -eu

TAP=zurfyx/homebrew-tap
SOURCE=${SOURCE_REPO:?set SOURCE_REPO, as owner/name}

TAG=$(gh api "repos/$SOURCE/releases/latest" --jq .tag_name 2>/dev/null || true)
case "$TAG" in
  v[0-9]*.[0-9]*.[0-9]*) VERSION=${TAG#v} ;;
  *) echo "No release yet: nothing for the tap."; exit 0 ;;
esac

# The checksum is the one published with the release, not one computed again here.
SHA256=$(gh release download "$TAG" --repo "$SOURCE" --pattern "minitart-$VERSION.tar.gz.sha256" --output - | cut -d' ' -f1)
node scripts/release.mjs formula "$VERSION" "$SHA256" > formula.rb

CURRENT=$(gh api "repos/$TAP/contents/Formula/minitart.rb" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true)
if [ "$CURRENT" = "$(cat formula.rb)" ]; then
  echo "The tap already has minitart $VERSION."
  exit 0
fi

BRANCH="minitart-$VERSION"
BASE=$(gh api "repos/$TAP/git/ref/heads/main" --jq .object.sha)
gh api "repos/$TAP/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$BASE" >/dev/null 2>&1 || true

# The file's current blob on that branch, if it is there, is what an update must name.
BLOB=$(gh api "repos/$TAP/contents/Formula/minitart.rb?ref=$BRANCH" --jq .sha 2>/dev/null || true)
if [ -n "$BLOB" ]; then
  gh api -X PUT "repos/$TAP/contents/Formula/minitart.rb" \
    -f message="minitart $VERSION" -f branch="$BRANCH" -f sha="$BLOB" \
    -f content="$(base64 < formula.rb | tr -d '\n')" >/dev/null
else
  gh api -X PUT "repos/$TAP/contents/Formula/minitart.rb" \
    -f message="minitart $VERSION" -f branch="$BRANCH" \
    -f content="$(base64 < formula.rb | tr -d '\n')" >/dev/null
fi

gh pr view "$BRANCH" --repo "$TAP" >/dev/null 2>&1 ||
  gh pr create --repo "$TAP" --head "$BRANCH" --base main \
    --title "minitart $VERSION" \
    --body "Formula for [minitart $VERSION](https://github.com/$SOURCE/releases/tag/$TAG), rendered by its release workflow."

# The tap's own CI installs the formula and runs its test. Only then is it merged.
gh pr checks "$BRANCH" --repo "$TAP" --watch --required --interval 20
gh pr merge "$BRANCH" --repo "$TAP" --squash --delete-branch
echo "The tap has minitart $VERSION."
