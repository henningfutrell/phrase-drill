#!/usr/bin/env bash
# Build and publish dist/ to the gh-pages branch, serving the app at
# https://henningfutrell.github.io/phrase-drill/.
#
# gh-pages also hosts spike/ — a device diagnostic cited as evidence
# elsewhere — which this script must never delete. Everything else at the
# branch root is replaced with the fresh build on every run.
#
# No `gh-pages` npm package: not a dependency of this project, and this repo's
# doctrine is not to add one for a single `git`-shaped command. Plain
# /usr/bin/git via a throwaway worktree instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> Building"
npm run build

if [ ! -f dist/index.html ]; then
  echo "deploy.sh: dist/index.html missing after build — aborting" >&2
  exit 1
fi

WORKTREE="$(mktemp -d)"
cleanup() {
  /usr/bin/git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  /usr/bin/git branch -D gh-pages-deploy >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Fetching gh-pages"
/usr/bin/git fetch origin gh-pages

echo "==> Checking out gh-pages into a throwaway worktree"
/usr/bin/git worktree add -B gh-pages-deploy "$WORKTREE" origin/gh-pages

echo "==> Replacing branch root with the new build (preserving spike/, .nojekyll)"
find "$WORKTREE" -mindepth 1 -maxdepth 1 \
  ! -name '.git' ! -name 'spike' ! -name '.nojekyll' \
  -exec rm -rf {} +

cp -r dist/. "$WORKTREE"/
touch "$WORKTREE"/.nojekyll

SOURCE_SHA="$(/usr/bin/git rev-parse --short HEAD)"
cat > "$WORKTREE"/README.md <<EOF
phrase-drill — GitHub Pages

Root (\`/\`): the built app, published by scripts/deploy.sh from commit
$SOURCE_SHA. Do not hand-edit; re-run \`npm run deploy\`.

\`spike/\`: an unrelated device diagnostic, cited as evidence elsewhere.
deploy.sh preserves it — never delete this directory.
EOF

cd "$WORKTREE"
/usr/bin/git add -A

if /usr/bin/git diff --cached --quiet; then
  echo "==> Nothing changed; gh-pages already matches this build"
  exit 0
fi

/usr/bin/git commit -m "deploy: publish dist from ${SOURCE_SHA}"

echo "==> Pushing gh-pages"
/usr/bin/git push origin gh-pages-deploy:gh-pages

echo "==> Done: https://henningfutrell.github.io/phrase-drill/"
