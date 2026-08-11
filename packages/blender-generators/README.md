# Blender Generators

Preferred: use the wrapper script, which finds Blender automatically (`BLENDER_BIN` env var → `blender` on PATH → `/Applications/Blender.app/Contents/MacOS/Blender`):

```bash
bash scripts/render-one-room.sh \
  packages/berkeley-data/halls/unit-3-standard-triple.json \
  assets/glb/berkeley/unit-3-standard-triple.glb \
  assets/blend/berkeley/unit-3-standard-triple.blend
```

For the Unit 3 triple specifically, `corepack pnpm render:unit3` runs the same thing. `corepack pnpm demo:unit3` renders **both** the triple and the double and copies the GLBs into `apps/web/public/models/berkeley/`.

Direct invocation (any platform, Blender on PATH or full path to the executable):

```bash
blender --background --python packages/blender-generators/generate_dorm_room.py -- \
  --schema packages/berkeley-data/halls/unit-3-standard-triple.json \
  --out assets/glb/berkeley/unit-3-standard-triple.glb \
  --blend assets/blend/berkeley/unit-3-standard-triple.blend
```

## What the generator produces (photoreal polish round)

- **Multi-part furniture** built parametrically from `dimensions_m`: chairs (seat/backrest/legs), desks (top, side panels, 3-drawer pedestal with handles), closets (doors, handles, kick base), dressers (drawer fronts, knobs), loft/bunk/twin beds (posts, rails, platforms, guardrails, ladders, soft-beveled mattresses and pillows), Microchill.
- **Real wall openings**: the door and window reveals are boolean-cut from the walls (EXACT solver, with a glued-on fallback if a cut fails), with casing, frame, sill, handle, and baseboards.
- **Procedural numpy textures**, generated deterministically (`TEX_SEED`) into a temp dir at export time and packed into the GLB — six tileable sets (walnut, light laminate, navy fabric, gray carpet, wall paint, brushed metal), each with base color (sRGB), ORM (Non-Color; G=roughness, B=metallic wired via Separate Color — the pattern glTF-Blender-IO repacks), and an OpenGL Y+ normal map. **No image is ever downloaded or copied** (project rule 9).
- **Bevels + smooth shading** on every part via the shared `beveled_box()` helper (also applies UV cube-projection and metadata).

## Naming contract with the web viewer (load-bearing — do not rename)

- Walls: exact top-level names `wall_entry`, `wall_back_window`, `wall_left`, `wall_right`; their centroid x/z drives the viewer's dollhouse wall culling.
- Shell: `floor`, `ceiling` (ceiling is hidden by the viewer by name).
- Furniture parts are **flat top-level objects** named `<group>_<n>_<part>` (e.g. `desk_2_drawer_1_front`) so the viewer's prefix grouping collects them; never let one group's part name start with another group's prefix.
- Wall-attached elements (door/window assemblies, casing, sill, `trim_baseboard_*`) are **parented to their wall** so they hide with it in the dollhouse view. `trim_*` deliberately matches no furniture group.

The generator resolves each shell axis from a positive, verified, non-estimated `room_shell` value when available; otherwise it uses the corresponding required `visualization_shell` estimate. These visualization values are sourced geometry inputs only: `room_shell` remains the exact-measurement surface, and null axes must still display as unknown. Generated shell objects store the selected source, confidence, dimension status, geometry basis, and per-axis provenance as GLB node `extras`.

Scene validation is fatal: if required shell/door/window objects are missing, if a mesh name violates the naming contract, or if textures are missing, the script prints the failures and exits 1 without exporting.

## Post-export optimization

`scripts/render-one-room.sh` runs this automatically after export:

```bash
corepack pnpm exec gltf-transform prune <glb> <tmp1>
corepack pnpm exec gltf-transform dedup <tmp1> <tmp2>
corepack pnpm exec gltf-transform webp  <tmp2> <glb>   # EXT_texture_webp — three decodes natively
corepack pnpm exec gltf-transform inspect <glb>        # confirm textures + node extras present
```

Do not use Draco or KTX2 compression — the web viewer's `useGLTF` has no decoders configured. WebP is fine (three ≥0.156 supports `EXT_texture_webp` out of the box).
