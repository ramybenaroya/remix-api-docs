#!/bin/bash
#
# Deploy the contents of docs/ to the gh-pages branch.
#
# Builds the search index, rewrites absolute paths for the GitHub Pages base
# path (so a *project* site under /<repo>/ works), then publishes as a fresh
# commit on gh-pages using a temporary git index — it never touches your working
# tree or the main branch, so docs/ stays root-relative and re-syncable.
#
#   ./deploy.sh                      # build + rewrite + publish to gh-pages + push
#   ./deploy.sh --configure-pages    # also point GitHub Pages at gh-pages (needs gh, one-time)
#
# Base path defaults to "/<repo-name>" (derived from origin). Override with
# BASE_PATH, e.g. BASE_PATH="" ./deploy.sh for root hosting (custom domain / user site).
#
set -euo pipefail

BRANCH="gh-pages"
SRC="docs"
REMOTE="origin"
CONFIGURE_PAGES=0
[ "${1:-}" = "--configure-pages" ] && CONFIGURE_PAGES=1

# Operate from the repo root (this script lives there).
cd "$(dirname "$0")"
GIT_DIR_ABS="$PWD/.git"

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
command -v node >/dev/null || { echo "error: node is required" >&2; exit 1; }
[ -d "$SRC" ] || { echo "error: $SRC/ not found" >&2; exit 1; }

# Base path the project site is served under (e.g. /remix-api-docs). Auto-derived
# from the repo name unless BASE_PATH is set in the environment.
REPO_NAME="$(basename -s .git "$(git config --get "remote.${REMOTE}.url")")"
BASE_PATH="${BASE_PATH-/$REPO_NAME}"
export BASE_PATH

# 1. Build the search index and re-inject search.js into the docs.
echo "==> Building search index"
node tools/build-search.mjs

# 2. Copy docs/ to a temp dir and rewrite absolute paths for BASE_PATH there, so
#    the published site works under the sub-path while docs/ on main stays clean.
SHA="$(git rev-parse --short HEAD)"
MSG="Deploy docs to ${BRANCH} (source ${SHA}${BASE_PATH:+, base ${BASE_PATH}})"
TMP_DIR="$(mktemp -d)"
TMP_INDEX="$TMP_DIR/index"
SITE="$TMP_DIR/site"
trap 'rm -rf "$TMP_DIR"' EXIT

cp -R "$SRC" "$SITE"
node tools/rewrite-base.mjs "$SITE"
# A project-site CNAME would force a custom domain we may not control; drop it
# unless hosting at the root (empty BASE_PATH keeps any CNAME as-is).
[ -n "$BASE_PATH" ] && rm -f "$SITE/CNAME"

# 3. Stage the rewritten site into a throwaway index so its paths sit at the
#    branch root (site/index.html -> /index.html, site/search.js -> /search.js, ...).
echo "==> Staging $SRC/ for $BRANCH"
GIT_DIR="$GIT_DIR_ABS" GIT_WORK_TREE="$SITE" GIT_INDEX_FILE="$TMP_INDEX" \
  git -C "$SITE" add --all
TREE="$(GIT_DIR="$GIT_DIR_ABS" GIT_INDEX_FILE="$TMP_INDEX" git write-tree)"

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
