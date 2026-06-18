#!/usr/bin/env bash
# Cut a new Subunit Desktop release. Bumps the version in package.json,
# src-tauri/tauri.conf.json and src-tauri/Cargo.toml, commits, tags, and pushes —
# GitHub Actions then builds the signed macOS app + DMG and writes the auto-update
# manifest. The running app picks it up from /releases/latest within ~24h (or on
# next launch). Usage: ./release.sh 0.1.1
set -euo pipefail
cd "$(dirname "$0")"
ver="${1:?usage: ./release.sh <version, e.g. 0.1.1>}"; ver="${ver#v}"
[[ "$ver" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z"; exit 1; }

# package.json + tauri.conf.json (JSON — bump via node, preserves formatting reasonably)
node -e "for(const f of ['package.json','src-tauri/tauri.conf.json']){const p=require('./'+f);p.version='$ver';require('fs').writeFileSync(f,JSON.stringify(p,null,2)+'\n');}"
# Cargo.toml [package] version only
sed -i '' -e '/^\[package\]/,/^\[/ s/^version = ".*"/version = "'"$ver"'"/' src-tauri/Cargo.toml

git add -A
git commit -q -m "release v$ver"
git tag "v$ver"
git push -q && git push -q origin "v$ver"
echo "✓ tagged v$ver — CI building: https://github.com/subunit-ai/subunit-desktop/actions"
echo "  download when green: https://github.com/subunit-ai/subunit-desktop/releases/latest"
