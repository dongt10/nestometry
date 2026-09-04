#!/usr/bin/env bash
set -euo pipefail

SCHEMA_PATH="${1:-packages/berkeley-data/halls/unit-3-standard-triple.json}"
OUT_GLB="${2:-assets/glb/berkeley/unit-3-standard-triple.glb}"
OUT_BLEND="${3:-assets/blend/berkeley/unit-3-standard-triple.blend}"
if [ -n "${4:-}" ]; then
  OUT_COLLIDERS="$4"
elif [[ "$OUT_GLB" == assets/glb/* ]]; then
  OUT_COLLIDERS="assets/colliders/${OUT_GLB#assets/glb/}"
  OUT_COLLIDERS="${OUT_COLLIDERS%.glb}.colliders.json"
else
  OUT_COLLIDERS="${OUT_GLB%.glb}.colliders.json"
fi

mkdir -p "$(dirname "$OUT_GLB")" "$(dirname "$OUT_BLEND")" "$(dirname "$OUT_COLLIDERS")"

# Resolution order: BLENDER_BIN env var, then PATH, then the macOS app bundle.
if [ -z "${BLENDER_BIN:-}" ]; then
  if command -v blender >/dev/null 2>&1; then
    BLENDER_BIN="blender"
  elif [ -x "/Applications/Blender.app/Contents/MacOS/Blender" ]; then
    BLENDER_BIN="/Applications/Blender.app/Contents/MacOS/Blender"
  else
    echo "ERROR: Blender not found. Install Blender or set BLENDER_BIN to the executable." >&2
    exit 1
  fi
fi

"$BLENDER_BIN" --background --python packages/blender-generators/generate_dorm_room.py -- \
  --schema "$SCHEMA_PATH" \
  --out "$OUT_GLB" \
  --blend "$OUT_BLEND" \
  --collider-manifest "$OUT_COLLIDERS"

# ---------------------------------------------------------------------------
# Post-export web optimization: prune unused data -> dedup shared datablocks ->
# webp-compress the procedural PNG textures (NO Draco — the viewer loads GLBs
# without a Draco decoder). Each step writes to a temp file so a mid-pipeline
# failure never corrupts the export in place.
# ---------------------------------------------------------------------------
echo "Optimizing GLB for web (prune -> dedup -> webp, no Draco)..."
TMP_A="$(mktemp -t dorm_opt_a.XXXXXX).glb"
TMP_B="$(mktemp -t dorm_opt_b.XXXXXX).glb"
trap 'rm -f "$TMP_A" "$TMP_B"' EXIT

corepack pnpm exec gltf-transform prune "$OUT_GLB" "$TMP_A"
corepack pnpm exec gltf-transform dedup "$TMP_A" "$TMP_B"
corepack pnpm exec gltf-transform webp  "$TMP_B" "$OUT_GLB"
node scripts/finalize-collider-manifest.mjs "$OUT_COLLIDERS" "$OUT_GLB"

# Report final size and warn past the 10 MB web budget.
BYTES=$(wc -c < "$OUT_GLB" | tr -d ' ')
MB=$(awk -v b="$BYTES" 'BEGIN { printf "%.2f", b / 1048576 }')
echo "Final optimized GLB: $OUT_GLB (${MB} MB)"
if [ "$BYTES" -gt 10485760 ]; then
  echo "WARNING: GLB is larger than 10 MB — over the web delivery budget. Reduce texture sizes." >&2
fi
