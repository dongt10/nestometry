#!/usr/bin/env bash
set -euo pipefail

if ! command -v corepack >/dev/null 2>&1; then
  echo "corepack not found. Install a supported Node.js release, then rerun."
  exit 1
fi

corepack pnpm install --frozen-lockfile

echo "Bootstrap complete. Run 'corepack pnpm dev' to start the viewer."
