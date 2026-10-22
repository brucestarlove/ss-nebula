#!/usr/bin/env bash
# Makes what GitHub gets for a release (PLAN.md §12 Q12): one new commit on
# GitHub's main whose tree is this checkout's HEAD minus the internal plan,
# the lane logs and reviews, and the sketch. The sketch's assets, fonts and
# CSS stay, because the tests read them. The working branch's own history
# never goes to GitHub: its slice-3 commits held private drawings as test
# fixtures before round 3 replaced them.
#
#   scripts/public-release.sh 2.0.0 Files   # makes branch release/2.0.0; pushes nothing
#   git push github release/2.0.0:main      # publishes it; Vercel deploys GitHub's main
set -euo pipefail

version="${1:?usage: scripts/public-release.sh <version> [name]}"
title="Nebula ${version}${2:+, $2}"
remote="${NEBULA_PUBLIC_REMOTE:-github}"
branch="release/${version}"
source="$(git rev-parse --short HEAD)"

git fetch --quiet "$remote" main

index="$(mktemp)"
trap 'rm -f "$index"' EXIT
export GIT_INDEX_FILE="$index"
git read-tree HEAD
git rm -rq --cached --ignore-unmatch -- PLAN.md docs \
  sketches/workspace/README.md sketches/workspace/index.html sketches/workspace/sketch.js \
  sketches/workspace/renders sketches/workspace/vendor
tree="$(git write-tree)"
unset GIT_INDEX_FILE

if git ls-tree -r --name-only "$tree" | grep -E '^(PLAN\.md|docs/)|/Edraw - (Starscape|Starscape SongClip|ss Zipcode app)\.md$'; then
  echo "public-release: those internal files are still in the tree, so nothing was made." >&2
  exit 1
fi

commit="$(git commit-tree "$tree" -p "$remote/main" -m "$title" -m "Built from ${source} by scripts/public-release.sh. What changed: CHANGELOG.md.")"
git branch -f "$branch" "$commit"
echo "Made ${branch} (${commit:0:7}): one commit on ${remote}/main ($(git rev-parse --short "$remote/main")), from ${source}."
git diff --stat "$remote/main" "$branch" | tail -n 1
echo "Publish it with: git push ${remote} ${branch}:main"
