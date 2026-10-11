#!/usr/bin/env bash
# Builds the PNGs of every cockpit tab: seeds a busy session in a scratch copy of the plugin, dumps each
# tab's element tree, and draws the trees in headless Chrome (see .shots/render.mjs).
# usage: .shots/run.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "${1:?usage: .shots/run.sh <out-dir>}"
out="$(cd "$1" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$here/." "$work/"
rm -rf "$work/.git" "$work/.shots"
cp "$here/.shots/shots.test.ts" "$work/tests/shots.test.ts"
mkdir -p "$out"
(cd "$work" && claude plugin test . 2>&1) > "$work/log.txt" || { tail -30 "$work/log.txt"; exit 1; }
sed -n 's/.*@@TREES@@\(.*\)@@END@@.*/\1/p' "$work/log.txt" > "$out/trees.json"
[ -s "$out/trees.json" ] || { echo "no trees captured"; tail -30 "$work/log.txt"; exit 1; }
node "$here/.shots/render.mjs" "$out"
