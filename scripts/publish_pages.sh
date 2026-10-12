#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit the source changes before publishing.' >&2
  exit 1
fi
npm test
node scripts/validate_data.mjs
site_tree=$(git rev-parse HEAD:web)
source_sha=$(git rev-parse HEAD)
parents=()
if git ls-remote --exit-code origin refs/heads/gh-pages >/dev/null; then
  git fetch origin gh-pages
  parents=(-p "$(git rev-parse FETCH_HEAD)")
fi
site_commit=$(printf 'Deploy listening review from %s\n' "$source_sha" | git commit-tree "$site_tree" "${parents[@]}")
git push origin HEAD:main
git push origin "$site_commit:refs/heads/gh-pages"
echo 'Published web tree. GitHub Pages must be configured for gh-pages, root directory.'
