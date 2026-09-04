#!/usr/bin/env bash
set -euo pipefail

TRIPLE_SCHEMA="packages/berkeley-data/halls/unit-3-standard-triple.json"
TRIPLE_GLB="assets/glb/berkeley/unit-3-standard-triple.glb"
TRIPLE_BLEND="assets/blend/berkeley/unit-3-standard-triple.blend"

DOUBLE_SCHEMA="packages/berkeley-data/halls/unit-3-standard-double.json"
DOUBLE_GLB="assets/glb/berkeley/unit-3-standard-double.glb"
DOUBLE_BLEND="assets/blend/berkeley/unit-3-standard-double.blend"

WEB_DIR="apps/web/public/models/berkeley"
COLLIDER_DIR="assets/colliders/berkeley"

if ! command -v corepack >/dev/null 2>&1; then
  echo "ERROR: corepack is not installed. Install a supported Node.js release, then rerun."
  exit 1
fi

corepack pnpm install --frozen-lockfile
corepack pnpm validate:room "$TRIPLE_SCHEMA"
corepack pnpm validate:room "$DOUBLE_SCHEMA"

# Same resolution order as render-one-room.sh: BLENDER_BIN env, PATH, macOS app bundle.
if [ -z "${BLENDER_BIN:-}" ]; then
  if command -v blender >/dev/null 2>&1; then
    BLENDER_BIN="blender"
  elif [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
    BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
  fi
fi

if [ -n "${BLENDER_BIN:-}" ]; then
  # Render + optimize both room types (render-one-room.sh runs the webp step).
  BLENDER_BIN="$BLENDER_BIN" bash scripts/render-one-room.sh "$TRIPLE_SCHEMA" "$TRIPLE_GLB" "$TRIPLE_BLEND"
  BLENDER_BIN="$BLENDER_BIN" bash scripts/render-one-room.sh "$DOUBLE_SCHEMA" "$DOUBLE_GLB" "$DOUBLE_BLEND"

  mkdir -p "$WEB_DIR"
  cp "$TRIPLE_GLB" "$WEB_DIR/"
  cp "$DOUBLE_GLB" "$WEB_DIR/"
  cp "$COLLIDER_DIR/unit-3-standard-triple.colliders.json" "$WEB_DIR/"
  cp "$COLLIDER_DIR/unit-3-standard-double.colliders.json" "$WEB_DIR/"
  echo "Copied both optimized GLBs and collider manifests to $WEB_DIR/."
else
  echo "WARNING: Blender not found. Skipping GLB render."
  echo "Install Blender (or set BLENDER_BIN), then run: corepack pnpm demo:unit3"
fi

corepack pnpm build

echo "Unit 3 demo build flow complete. If Blender was available, both GLBs copied to $WEB_DIR/."
