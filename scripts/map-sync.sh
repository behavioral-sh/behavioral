#!/bin/bash
# Sync the map (plan.md + .prompts/) to the private map repo.
#
# The map is gitignored in the PUBLIC repo (behavioral-sh/behavioral) and
# versioned at the PRIVATE behavioral-sh/behavioral-map (the 2026-10-05
# map-repo ruling). This script is the drop-in replacement for the
# blackwell rsync convention: run it at every landing wrap (when prompts
# land/delete) and after any map edit you want history for.
#
# Usage: scripts/map-sync.sh "sync note"
set -euo pipefail

MAP_REPO="${MAP_REPO:-$HOME/Workspace/behavioral-map}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTE="${1:-map sync}"

if [ ! -d "$MAP_REPO/.git" ]; then
  echo "map repo missing at $MAP_REPO — clone git@github.com:behavioral-sh/behavioral-map.git there first" >&2
  exit 1
fi

rsync -a "$REPO_ROOT/plan.md" "$REPO_ROOT/.prompts" "$MAP_REPO/"
cd "$MAP_REPO"
if git diff --quiet && [ -z "$(git status --porcelain)" ]; then
  echo "map unchanged — nothing to sync"
  exit 0
fi
git add -A
git commit -m "map sync: $NOTE"
git push
echo "synced to behavioral-sh/behavioral-map ($(git rev-parse --short HEAD))"