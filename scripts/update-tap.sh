#!/bin/sh
# Makes the Homebrew tap match the newest release (docs/release.md): minitart's formula, or
# with PRODUCT=minitart-app, the menu bar app's cask (D26).
#
# Needs GH_TOKEN, a token that can write to the tap (the release bot's), and SOURCE_REPO.
# Safe to run again at any time: a tap that is already right is left alone, and a proposal
# is always rebuilt on the tap's current main, so a stale one never gets in the way.
set -eu

TAP=zurfyx/homebrew-tap
SOURCE=${SOURCE_REPO:?set SOURCE_REPO, as owner/name}
PRODUCT=${PRODUCT:-minitart}

case "$PRODUCT" in
  minitart)
    # minitart's releases are the repo's latest; the app's never are.
    TAG=$(gh api "repos/$SOURCE/releases/latest" --jq .tag_name 2>/dev/null || true)
    PREFIX=v FILE=Formula/minitart.rb TITLE=minitart
    ;;
  minitart-app)
    TAG=$(gh release list --repo "$SOURCE" --limit 100 --json tagName \
      --jq '[.[].tagName | select(startswith("app-v"))][0] // ""' 2>/dev/null || true)
    PREFIX=app-v FILE=Casks/minitart-app.rb TITLE="minitart app"
    ;;
  *) echo "PRODUCT is minitart or minitart-app, not $PRODUCT." >&2; exit 2 ;;
esac

case "$TAG" in
  "$PREFIX"[0-9]*.[0-9]*.[0-9]*) VERSION=${TAG#"$PREFIX"} ;;
  *) echo "No $TITLE release yet: nothing for the tap."; exit 0 ;;
esac

# The checksum is the one published with the release, not one computed again here.
if [ "$PRODUCT" = minitart ]; then
  SHA256=$(gh release download "$TAG" --repo "$SOURCE" --pattern "minitart-$VERSION.tar.gz.sha256" --output - | cut -d' ' -f1)
  node scripts/release.mjs formula "$VERSION" "$SHA256" > rendered.rb
else
  SHA256=$(gh release download "$TAG" --repo "$SOURCE" --pattern "minitart-app-$VERSION.zip.sha256" --output - | cut -d' ' -f1)
  node scripts/release-app.mjs cask "$VERSION" "$SHA256" > rendered.rb
fi

# GitHub answers 502 now and then. A step that only failed is tried again, twice.
retry() {
  tries=1
  until "$@"; do
    if [ "$tries" -ge 3 ]; then
      return 1
    fi
    tries=$((tries + 1))
    sleep 10
  done
}

open_pr() {
  gh pr list --repo "$TAP" --head "$BRANCH" --state open --json number --jq '.[0].number // empty'
}

propose() {
  gh pr create --repo "$TAP" --head "$BRANCH" --base main \
    --title "$TITLE $VERSION" \
    --body "$FILE for [$TITLE $VERSION](https://github.com/$SOURCE/releases/tag/$TAG), rendered by its release workflow." >/dev/null ||
    [ -n "$(open_pr)" ]
}

current() {
  gh api "repos/$TAP/contents/$FILE?ref=$1" --jq .content 2>/dev/null | base64 -d 2>/dev/null || true
}

if [ "$(current main)" = "$(cat rendered.rb)" ]; then
  echo "The tap already has $TITLE $VERSION."
  exit 0
fi

BRANCH="$PRODUCT-$VERSION"

# Up to three goes: the tap has other projects' releases merging into it, and its main has
# to be in the branch before a merge is allowed.
attempt=1
while :; do
  # The branch starts from the tap's main as it is now, whatever an earlier run left there.
  BASE=$(gh api "repos/$TAP/git/ref/heads/main" --jq .object.sha)
  gh api -X PATCH "repos/$TAP/git/refs/heads/$BRANCH" -f sha="$BASE" -F force=true >/dev/null 2>&1 ||
    gh api "repos/$TAP/git/refs" -f ref="refs/heads/$BRANCH" -f sha="$BASE" >/dev/null

  # An update has to name the file's current blob; a new file has none.
  BLOB=$(gh api "repos/$TAP/contents/$FILE?ref=$BRANCH" --jq .sha 2>/dev/null || true)
  gh api -X PUT "repos/$TAP/contents/$FILE" \
    -f message="$TITLE $VERSION" -f branch="$BRANCH" ${BLOB:+-f sha="$BLOB"} \
    -f content="$(base64 < rendered.rb | tr -d '\n')" >/dev/null

  # An open proposal for this branch is picked up; a merged or closed one is not. Creating
  # one counts as done when one is open afterwards: GitHub can fail the answer to a request
  # it carried out, and asking again would then be refused as a duplicate.
  PR=$(open_pr)
  if [ -z "$PR" ]; then
    retry propose
    PR=$(open_pr)
  fi

  # The tap's own CI installs the formula and runs its test. It takes a moment to start:
  # watching before it has would end at once with nothing to watch.
  waited=0
  until [ "$(gh pr view "$PR" --repo "$TAP" --json statusCheckRollup --jq '.statusCheckRollup | length')" -gt 0 ]; do
    waited=$((waited + 10))
    if [ "$waited" -gt 300 ]; then
      echo "The tap's CI did not start on pull request $PR." >&2
      exit 1
    fi
    sleep 10
  done
  gh pr checks "$PR" --repo "$TAP" --watch --required --interval 20

  if gh pr merge "$PR" --repo "$TAP" --squash --delete-branch; then
    break
  fi
  if [ "$attempt" -ge 3 ]; then
    echo "Could not merge pull request $PR on the tap." >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  echo "The tap moved on meanwhile; proposing again on its new main."
done

if [ "$(current main)" != "$(cat rendered.rb)" ]; then
  echo "The pull request merged, and the tap's $FILE is not the one proposed." >&2
  exit 1
fi
echo "The tap has $TITLE $VERSION."
