#!/usr/bin/env bash
# Builds the workspace's public demo (ide-template/frontend, VITE_DEMO=1) and
# puts it at dist/demo, so the landing serves it at /demo/. Run after
# `astro build`; part of `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."
FE=../ide-template/frontend
[ -d "$FE/node_modules" ] || npm --prefix "$FE" ci --no-audit --no-fund
npm --prefix "$FE" run build:demo
rm -rf dist/demo
cp -R "$FE/dist-demo" dist/demo
