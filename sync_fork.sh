#!/bin/bash
#
# Create a fresh branch off main and sync it with the latest code from the
# upstream (original) repository.
#
#   ./sync_fork.sh [branch-name]
#
# Steps:
#   1. ensure an `upstream` remote points at the original repo (add if missing),
#   2. fetch origin + upstream,
#   3. fast-forward local main to origin/main,
#   4. create/checkout a new branch off main,
#   5. merge upstream's default branch into it.
#
# Leaves the merge result in your working tree for review (push / open a PR
# yourself). On conflicts it stops so you can resolve them.
#
# Override defaults via env:
#   UPSTREAM_URL     (default https://github.com/remix-run/remix-api-docs.git)
#   UPSTREAM_REMOTE  (default upstream)
#   MAIN_BRANCH      (default main)
#   UPSTREAM_BRANCH  (default: upstream's HEAD branch, else main)
#
set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/remix-run/remix-api-docs.git}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
NEW_BRANCH="${1:-sync-upstream-$(date +%Y%m%d-%H%M%S)}"

# Operate from the repo root (this script lives there).
cd "$(dirname "$0")"

command -v git >/dev/null || { echo "error: git is required" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  { echo "error: not a git repository" >&2; exit 1; }

# Refuse to run with uncommitted changes — the merge needs a clean tree.
if ! git diff-index --quiet HEAD -- || [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "error: working tree has uncommitted changes; commit or stash first" >&2
  exit 1
fi

# 1. Ensure the upstream remote exists and points where we expect.
if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
else
  echo "==> Adding remote $UPSTREAM_REMOTE -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

# 2. Fetch both remotes.
echo "==> Fetching $ORIGIN_REMOTE and $UPSTREAM_REMOTE"
git fetch --prune "$ORIGIN_REMOTE"
git fetch --prune --tags "$UPSTREAM_REMOTE"

# Determine upstream's default branch (fall back to main).
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-}"
if [ -z "$UPSTREAM_BRANCH" ]; then
  UPSTREAM_BRANCH="$(git remote show "$UPSTREAM_REMOTE" 2>/dev/null \
    | sed -n 's/.*HEAD branch: //p')"
  UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
fi

# 3. Update local main to match origin/main (fast-forward only).
echo "==> Updating $MAIN_BRANCH from $ORIGIN_REMOTE"
git checkout "$MAIN_BRANCH"
if ! git merge --ff-only "$ORIGIN_REMOTE/$MAIN_BRANCH"; then
  echo "warning: could not fast-forward $MAIN_BRANCH to $ORIGIN_REMOTE/$MAIN_BRANCH" >&2
  echo "         (local $MAIN_BRANCH has diverged); branching from current $MAIN_BRANCH" >&2
fi

# 4. Create and switch to the new branch off main.
echo "==> Creating branch $NEW_BRANCH off $MAIN_BRANCH"
git checkout -b "$NEW_BRANCH"

# 5. Merge upstream's latest into the new branch.
echo "==> Merging $UPSTREAM_REMOTE/$UPSTREAM_BRANCH into $NEW_BRANCH"
if git merge --no-edit "$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"; then
  echo
  echo "==> Done. $NEW_BRANCH is synced with $UPSTREAM_REMOTE/$UPSTREAM_BRANCH."
  echo "    Review, then push:  git push -u $ORIGIN_REMOTE $NEW_BRANCH"
else
  echo
  echo "!!! Merge stopped with conflicts. Resolve them, then:" >&2
  echo "      git add -A && git commit" >&2
  echo "    (or 'git merge --abort' to back out)." >&2
  exit 1
fi
