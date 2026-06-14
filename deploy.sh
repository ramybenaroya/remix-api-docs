#!/bin/bash
#
# Deploy the contents of docs/ to the gh-pages branch (served at the site root).
#
# Builds the search index first, then publishes docs/ as a fresh commit on
# gh-pages using a temporary git index — it never touches your working tree or
# the main branch. Run from anywhere; it operates on this repo.
#
#   ./deploy.sh                 # build + publish to gh-pages + push
#   ./deploy.sh --configure-pages   # also point GitHub Pages at gh-pages (needs gh, one-time)
#
set -euo pipefail

BRANCH="gh-pages"
SRC="docs"
REMOTE="origin"
CONFIGURE_PAGES=0
[ "${1:-}" = "--configure-pages" ] && CONFIGURE_PAGES=1

# Operate from the repo root (this script lives there).
cd "$(dirname "$0")"

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node is required" >&2; exit 1; }
[ -d "$SRC" ] || { echo "error: $SRC/ not found" >&2; exit 1; }

# 1. Build the search index and re-inject search.js into the docs.
echo "==> Building search index"
node tools/build-search.mjs

# 2. Stage docs/ contents into a throwaway index so their paths sit at the
#    branch root (docs/index.html -> /index.html, docs/CNAME -> /CNAME, ...).
SHA="$(git rev-parse --short HEAD)"
MSG="Deploy docs to ${BRANCH} (source ${SHA})"
# A fresh (non-existent) index path so git builds the tree from scratch — an
# empty pre-created file is not a valid index, so use a dir and let git make it.
TMP_DIR="$(mktemp -d)"
TMP_INDEX="$TMP_DIR/index"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Staging $SRC/ for $BRANCH"
GIT_INDEX_FILE="$TMP_INDEX" git --work-tree="$SRC" add --all
TREE="$(GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"

# 3. Commit the tree onto gh-pages, parented on the existing branch tip if any.
git fetch --quiet "$REMOTE" "$BRANCH" 2>/dev/null || true
PARENT=""
if git rev-parse --verify --quiet "$REMOTE/$BRANCH" >/dev/null; then
  PARENT="$(git rev-parse "$REMOTE/$BRANCH")"
elif git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  PARENT="$(git rev-parse "refs/heads/$BRANCH")"
fi

if [ -n "$PARENT" ]; then
  if [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then
    echo "==> No changes since last deploy; nothing to publish."
    exit 0
  fi
  COMMIT="$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")"
else
  COMMIT="$(git commit-tree "$TREE" -m "$MSG")"
fi

git update-ref "refs/heads/$BRANCH" "$COMMIT"

# 4. Publish.
echo "==> Pushing $BRANCH to $REMOTE"
git push "$REMOTE" "$BRANCH"

# 5. Optionally point GitHub Pages at the gh-pages branch root (one-time).
if [ "$CONFIGURE_PAGES" -eq 1 ]; then
  if command -v gh >/dev/null; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
    echo "==> Configuring GitHub Pages for $REPO (branch=$BRANCH, path=/)"
    gh api -X POST "repos/$REPO/pages" \
      -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 ||
      gh api -X PUT "repos/$REPO/pages" \
        -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 ||
      echo "    (could not auto-configure; set Pages source to $BRANCH / root in repo Settings)"
  else
    echo "    gh CLI not found; set Pages source to $BRANCH / root in repo Settings."
  fi
fi

echo "==> Done. Deployed $SRC/ to $BRANCH @ $(git rev-parse --short "$COMMIT")"
echo "    If this is the first deploy, set Pages source to '$BRANCH' / '(root)' in repo Settings."
