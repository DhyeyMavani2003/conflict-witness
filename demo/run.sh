#!/usr/bin/env bash
# Builds a throwaway repo with a base commit and a PR commit, then runs the full Conflict Witness loop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO_DIR:-$ROOT/.witness/demo-repo}"
BRAIN="${BRAIN_DIR:-$HOME/.conflict-witness/brain}"
rm -rf "$DEMO" && mkdir -p "$DEMO"
cp -R "$ROOT/demo/base/." "$DEMO/"
git -C "$DEMO" init -q -b main
git -C "$DEMO" add -A && git -C "$DEMO" -c user.name=demo -c user.email=demo@example.com commit -qm "base: acme-api agent instructions"
git -C "$DEMO" checkout -qb hotfix-speedup
cp -R "$ROOT/demo/pr/." "$DEMO/"
git -C "$DEMO" add -A && git -C "$DEMO" -c user.name=demo -c user.email=demo@example.com commit -qm "skills: faster incident hotfixes, MAJOR bump approval, legacy npm"
echo "demo repo: $DEMO (branch hotfix-speedup vs main)"
git -C "$DEMO" --no-pager diff --stat main hotfix-speedup
cd "$ROOT"
bun src/witness.ts check --repo "$DEMO" --base main --head hotfix-speedup --brain "$BRAIN" --task "fix an urgent production bug and open a PR" "$@" || true
