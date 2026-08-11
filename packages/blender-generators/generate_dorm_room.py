"""
Parametric Berkeley dorm room generator — photoreal polish round.

Run with Blender:

blender --background --python packages/blender-generators/generate_dorm_room.py -- \
  --schema packages/berkeley-data/halls/unit-3-standard-triple.json \
  --out assets/glb/berkeley/unit-3-standard-triple.glb \
  --blend assets/blend/berkeley/unit-3-standard-triple.blend

Design notes
------------
- 1 Blender unit = 1 meter.
- Measured room-shell dimensions are preferred per axis. When they are
  unavailable, required schema-backed visualization estimates drive geometry.
  Estimated geometry is tagged with source metadata (see custom_props); nothing
  here should be read as a verified measurement.
- All textures are GENERATED procedurally with numpy at export time into a
  throwaway tempfile.mkdtemp() directory (never the repo), loaded as bpy
  images, then packed so they embed inside the GLB. No image is ever
  downloaded or copied from a reference (see the source and privacy policy).
- The web viewer (RoomViewer3D.tsx) depends on:
    * exact top-level wall names + their centroid x/z (WallCuller normals),
    * floor/ceiling names,
    * furniture group prefixes (collectFurnitureGroups),
    * freestanding furniture staying flat top-level (grouping),
    * wall-attached trim parented to its wall (hides with the wall).
  Read the HARD CONSTRAINTS in the task before changing names/positions.
"""

import argparse
import json
import math
import os
import sys
import tempfile
from pathlib import Path

try:
    import bpy
    import bmesh
    from mathutils import Vector
except Exception as exc:  # pragma: no cover - only runs inside Blender
    raise RuntimeError("This script must be run with Blender's Python environment.") from exc

import numpy as np

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

# Deterministic master seed so every export is byte-stable.
TEX_SEED = 20260701

# Contact epsilon: when one box sits ON or presses flat AGAINST another visible
# surface, lift/offset the upper/outer box by this much so the two never share
# an exact face plane (kills z-fighting "texture glitching"). Applied only to
# real rendered contacts, never to internal frame joinery (posts/rails), where a
# gap would look like a broken bed frame.
CONTACT_EPS = 0.0025

# Area-rug slab thickness for room variants that have a verified free rug band.
RUG_T = 0.012

COLLECTIONS = ["RoomShell", "Doors", "Windows", "BuiltIns", "Furniture", "Decor", "Lights", "Cameras"]

# Known non-furniture mesh names / prefixes for the name-discipline assertion.
SHELL_NAMES = {"floor", "ceiling"}
WALL_PREFIX = "wall_"
TRIM_PREFIX = "trim_"

# Lived-in staging group (M1). Every staging mesh name starts with this prefix.
# The viewer treats `decor` as its own toggle group (a master switch), and the
# prefix does not collide with any furniture prefix (`decor_` vs `desk_` differ).
DECOR_PREFIX = "decor_"

# Furniture group prefixes recognised by the viewer. Longest / most-specific
# first is not required here (we test exact-or-startswith with underscore), but
# no prefix may be a leading fragment of another part's name (constraint 2).
FURNITURE_PREFIXES = [
    "twin_xl_bed",
    "loft_bed",
    "bunk_bed",
    "microchill",
    "bookshelf",
    "dresser",
    "closet",
    "window",
    "desk",
    "chair",
    "door",
]

# Populated per-run so validate_scene can assert texture coverage.
_TEXDIR = None
_MATERIALS = {}
_IMAGES = []

# Placement descriptors recorded by furniture/opening builders and consumed by
# the decor pass, so staging derives from the SAME parametric layout variables
# rather than duplicated magic coordinates (spec risk: decor/furniture drift).
_DESK1 = None      # {cx, cy, top, w, d, face} for desk index 0
_WINDOW = None     # {cx, wx, wz, sill, wall_y, wall} for the window opening
_LOFT_LADDER = None  # {x_max} leaning-stile X envelope (recorded by build_loft_bed)
_WINDOW_DESK = None  # {x_max, py} triple window-wall desk, for dresser_2 slotting
_DRESSERS = []     # [{px, py, top, side}] side-wall dressers, for vanity mirrors
_OPEN_FLOOR_Y_HI = None  # window-side limit of the open floor (rug zone)
_ALL_DESKS = []    # every desk record, for the secondary desk-prop pass


def is_standard_double(room):
    """True only for the canonical Unit 3-style standard double branch.

    Keeping this predicate explicit prevents the evidence-backed double details
    below from leaking into the triple (or a future single/suite generator).
    """
    return room.get("hall") == "Unit 3" and room.get("room_type") == "standard_double"


# --------------------------------------------------------------------------
# Args / scene setup
# --------------------------------------------------------------------------

def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", required=True, help="Path to room JSON schema")
    parser.add_argument("--out", required=True, help="Output GLB path")
    parser.add_argument("--blend", required=True, help="Output .blend path")
    return parser.parse_args(argv)


def clear_scene():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    # Purge orphan datablocks so re-runs stay deterministic (no Cube.001 drift).
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images,
                 bpy.data.textures, bpy.data.curves, bpy.data.lights,
                 bpy.data.cameras):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def ensure_collections():
    for name in COLLECTIONS:
        if name not in bpy.data.collections:
            col = bpy.data.collections.new(name)
            bpy.context.scene.collection.children.link(col)


def get_collection(name):
    return bpy.data.collections[name]


def link_to_collection(obj, collection_name):
    target = get_collection(collection_name)
    for col in list(obj.users_collection):
        col.objects.unlink(obj)
    target.objects.link(obj)


# --------------------------------------------------------------------------
# Procedural numpy textures
# --------------------------------------------------------------------------
#
# Every set produces three maps written to _TEXDIR:
#   <name>_basecolor.png   (sRGB, -> Base Color)
#   <name>_orm.png         (Non-Color, R=AO=1, G=roughness, B=metallic)
#   <name>_normal.png      (Non-Color, OpenGL Y+, from a height proxy)
# Maps are tileable: noise is generated with wrap-around FFT-based smoothing or
# mirror blending so opposite edges match.


def _wrap_noise(rng, size, scale, octaves=4):
    """Tileable value-noise in [0,1] built by summing low-frequency integer
    sine/cosine harmonics — periodic by construction, so it tiles seamlessly."""
    ys = np.linspace(0.0, 2.0 * np.pi, size, endpoint=False)
    xs = np.linspace(0.0, 2.0 * np.pi, size, endpoint=False)
    gx, gy = np.meshgrid(xs, ys)
    acc = np.zeros((size, size), dtype=np.float64)
    amp = 1.0
    total = 0.0
    freq = max(1, int(scale))
    for _ in range(octaves):
        # random integer harmonic frequencies keep the field periodic
        fx = rng.integers(1, freq + 1)
        fy = rng.integers(1, freq + 1)
        px = rng.uniform(0, 2.0 * np.pi)
        py = rng.uniform(0, 2.0 * np.pi)
        acc += amp * np.sin(fx * gx + px) * np.cos(fy * gy + py)
        total += amp
        amp *= 0.55
        freq = max(1, int(freq * 1.9))
    acc = acc / total
    return (acc - acc.min()) / (np.ptp(acc) + 1e-9)


def _fine_noise(rng, size):
    """White-ish fine speckle made tileable by mirror-blending the edges."""
    n = rng.random((size, size))
    # blend a border band with its mirror so wrap edges match
    b = max(2, size // 32)
    ramp = np.linspace(0.0, 1.0, b)[:, None]
    n[:b, :] = n[:b, :] * ramp + n[-b:, :][::-1] * (1 - ramp)
    n[-b:, :] = n[:b, :][::-1]
    ramp2 = np.linspace(0.0, 1.0, b)[None, :]
    n[:, :b] = n[:, :b] * ramp2 + n[:, -b:][:, ::-1] * (1 - ramp2)
    n[:, -b:] = n[:, :b][:, ::-1]
    return n


def _sobel_normal(height, strength=1.0):
    """Normal map from a height field via Sobel gradients, OpenGL Y+ convention.
    Uses np.roll (wrap mode) so the normal map is tileable too. Returns HxWx3 in
    [0,1] encoding (0.5+0.5*gx, 0.5+0.5*gy, up)."""
    h = height.astype(np.float64)
    # wrap-around Sobel
    gx = (
        np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)
    )
    gy = (
        np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)
    )
    gx *= strength
    gy *= strength
    # clamp so the encoded channels stay in range and the surface reads convex
    gx = np.clip(gx, -1.0, 1.0)
    gy = np.clip(gy, -1.0, 1.0)
    nx = 0.5 + 0.5 * gx
    ny = 0.5 + 0.5 * gy          # OpenGL Y+ (do NOT flip gy)
    nz = np.ones_like(h)         # packed flat blue; encoder normalizes on read
    out = np.stack([nx, ny, nz], axis=-1)
    return np.clip(out, 0.0, 1.0)


def _save_png(arr, path):
    """arr is HxWx(3|4) float in [0,1]; write via a bpy image so PNG encode is
    handled by Blender (no external libs)."""
    h, w = arr.shape[:2]
    if arr.shape[2] == 3:
        rgba = np.dstack([arr, np.ones((h, w), dtype=arr.dtype)])
    else:
        rgba = arr
    img = bpy.data.images.new(Path(path).stem, width=w, height=h, alpha=True)
    # Blender image pixels are bottom-up; flip rows so the PNG matches array top-down.
    flipped = rgba[::-1, :, :].astype(np.float32)
    img.pixels.foreach_set(flipped.reshape(-1))
    img.filepath_raw = str(path)
    img.file_format = "PNG"
    img.save()
    # remove the temp datablock; we reload from disk with the right colorspace
    bpy.data.images.remove(img)


def _build_set(name, size, base_rgb, rough_field, metal_value,
               height_field, normal_strength, color_field=None):
    """Write basecolor/orm/normal PNGs for one texture set into _TEXDIR."""
    base = np.empty((size, size, 3), dtype=np.float64)
    if color_field is not None:
        for c in range(3):
            base[..., c] = np.clip(color_field[..., c], 0.0, 1.0)
    else:
        for c in range(3):
            base[..., c] = base_rgb[c]
    orm = np.empty((size, size, 3), dtype=np.float64)
    orm[..., 0] = 1.0                       # AO placeholder
    orm[..., 1] = np.clip(rough_field, 0.03, 1.0)
    orm[..., 2] = metal_value               # scalar metallic
    nrm = _sobel_normal(height_field, normal_strength)

    _save_png(base, os.path.join(_TEXDIR, f"{name}_basecolor.png"))
    _save_png(orm, os.path.join(_TEXDIR, f"{name}_orm.png"))
    _save_png(nrm, os.path.join(_TEXDIR, f"{name}_normal.png"))


def generate_textures(room=None):
    """Generate the six tileable sets. Deterministic: each set seeds its own RNG."""
    global _TEXDIR
    _TEXDIR = tempfile.mkdtemp(prefix="dorm_tex_")

    # --- wood_walnut 512: mostly-straight grain bands + fine noise ---
    # Grain runs along Y. A gentle low-amplitude warp keeps it organic without
    # the "zebra wave" look; contrast is kept low so it reads as walnut.
    S = 512
    rng = np.random.default_rng(TEX_SEED + 1)
    xs = np.linspace(0, 1, S, endpoint=False)
    ys = np.linspace(0, 1, S, endpoint=False)
    gx, gy = np.meshgrid(xs, ys)
    warp = 0.012 * np.sin(2 * np.pi * (gy * 1.5)) + 0.010 * (_wrap_noise(rng, S, 3, 2) - 0.5)
    grain = 0.5 + 0.5 * np.sin(2 * np.pi * ((gx + warp) * 12.0))
    # low-freq streak variation so a few planks read darker than others
    streaks = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 3.0 + 1.3)
    fine = _fine_noise(rng, S)
    walnut_dark = np.array([0.19, 0.115, 0.075])
    walnut_light = np.array([0.29, 0.185, 0.125])
    tone = 0.35 * grain + 0.25 * streaks + 0.40 * 0.5   # blended, low-contrast
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = walnut_dark[c] + (walnut_light[c] - walnut_dark[c]) * tone
    col += (fine[..., None] - 0.5) * 0.015
    rough = 0.55 + 0.20 * grain                      # 0.55..0.75 varies with grain
    height = grain * 0.6 + fine * 0.4
    _build_set("wood_walnut", S, None, rough, 0.0, height, 0.7, color_field=col)

    # --- wood_maple 512: LIGHT blonde maple/oak — the primary furniture wood.
    # Berkeley dorm casework/beds read as pale natural wood, so this replaces
    # walnut on all furniture. Subtle mostly-straight grain, low contrast,
    # roughness ~0.5, gentle normal so the grain never shimmers. ---
    rng = np.random.default_rng(TEX_SEED + 10)
    warp = 0.010 * np.sin(2 * np.pi * (gy * 1.3)) + 0.008 * (_wrap_noise(rng, S, 3, 2) - 0.5)
    grain = 0.5 + 0.5 * np.sin(2 * np.pi * ((gx + warp) * 10.0))
    streaks = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 2.4 + 0.7)   # a few planks vary
    fine = _fine_noise(rng, S)
    maple_dark = np.array([0.66, 0.52, 0.34])        # warm blonde
    maple_light = np.array([0.82, 0.69, 0.49])
    tone = 0.30 * grain + 0.20 * streaks + 0.50 * 0.5  # low-contrast blonde
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = maple_dark[c] + (maple_light[c] - maple_dark[c]) * tone
    col += (fine[..., None] - 0.5) * 0.012
    rough = np.full((S, S), 0.50) + (grain - 0.5) * 0.08   # ~0.46..0.54
    height = grain * 0.5 + fine * 0.5
    _build_set("wood_maple", S, None, rough, 0.0, height, 0.45, color_field=col)

    # --- laminate_light 512: light oak, roughness ~0.35 ---
    rng = np.random.default_rng(TEX_SEED + 2)
    warp = 0.010 * np.sin(2 * np.pi * (gy * 1.2)) + 0.008 * (_wrap_noise(rng, S, 3, 2) - 0.5)
    grain = 0.5 + 0.5 * np.sin(2 * np.pi * ((gx + warp) * 9.0))
    fine = _fine_noise(rng, S)
    oak_dark = np.array([0.70, 0.58, 0.42])
    oak_light = np.array([0.83, 0.73, 0.56])
    tone = 0.4 * grain + 0.6 * 0.5                    # low-contrast light oak
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = oak_dark[c] + (oak_light[c] - oak_dark[c]) * tone
    col += (fine[..., None] - 0.5) * 0.012
    rough = np.full((S, S), 0.35) + (grain - 0.5) * 0.06
    height = grain * 0.5 + fine * 0.5
    _build_set("laminate_light", S, None, rough, 0.0, height, 0.4, color_field=col)

    # --- fabric_navy 512: woven speckle, roughness ~0.9, fine weave normal.
    # Weave frequency HALVED (64->32) and normal strength lowered (1.0->0.5) to
    # kill moire shimmer at typical viewing distance. ---
    rng = np.random.default_rng(TEX_SEED + 3)
    weave = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 32.0) * np.sin(2 * np.pi * gy * 32.0)
    speck = _fine_noise(rng, S)
    navy = np.array([0.10, 0.14, 0.28])
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = navy[c] * (0.85 + 0.30 * weave)
    col += (speck[..., None] - 0.5) * 0.04
    rough = np.full((S, S), 0.90) + (weave - 0.5) * 0.05
    height = weave * 0.6 + speck * 0.4
    _build_set("fabric_navy", S, None, rough, 0.0, height, 0.5, color_field=col)

    # --- carpet_blue 1024: deep muted dorm blue, keep speckle, roughness ~0.95.
    # (Replaces the old gray carpet per the Berkeley reference palette.) ---
    S2 = 1024
    rng = np.random.default_rng(TEX_SEED + 4)
    fibers = _fine_noise(rng, S2)
    low = _wrap_noise(rng, S2, 8, 4)
    blue = np.array([0.16, 0.22, 0.34])          # deep muted blue
    col = np.empty((S2, S2, 3))
    shade = 0.82 + 0.28 * fibers + 0.10 * (low - 0.5)
    for c in range(3):
        col[..., c] = np.clip(blue[c] * shade, 0, 1)
    rough = np.full((S2, S2), 0.95)
    height = fibers * 0.8 + low * 0.2
    _build_set("carpet_blue", S2, None, rough, 0.0, height, 1.4, color_field=col)

    # --- carpet_charcoal 1024: double-only charcoal/brown contract carpet.
    # The official Unit 3 double rendering is brown and the two direct double
    # walkthroughs are dark charcoal; none supports borrowing the triple's blue
    # floor. Generate this set only for doubles so triple datablocks/exports do
    # not change merely because this alternative material exists. ---
    if is_standard_double(room or {}):
        rng = np.random.default_rng(TEX_SEED + 14)
        fibers = _fine_noise(rng, S2)
        low = _wrap_noise(rng, S2, 8, 4)
        charcoal_brown = np.array([0.19, 0.175, 0.155])
        col = np.empty((S2, S2, 3))
        shade = 0.78 + 0.30 * fibers + 0.10 * (low - 0.5)
        for c in range(3):
            col[..., c] = np.clip(charcoal_brown[c] * shade, 0, 1)
        rough = np.full((S2, S2), 0.96)
        height = fibers * 0.8 + low * 0.2
        _build_set(
            "carpet_charcoal", S2, None, rough, 0.0, height, 1.4,
            color_field=col,
        )

    # --- paint_wall 512: near-white + faint roller noise, roughness ~0.9 ---
    rng = np.random.default_rng(TEX_SEED + 5)
    roller = _wrap_noise(rng, S, 3, 3)
    fine = _fine_noise(rng, S)
    white = np.array([0.90, 0.90, 0.88])
    col = np.empty((S, S, 3))
    shade = 0.985 + 0.03 * (roller - 0.5) + 0.01 * (fine - 0.5)
    for c in range(3):
        col[..., c] = np.clip(white[c] * shade, 0, 1)
    rough = np.full((S, S), 0.90) + (roller - 0.5) * 0.04
    height = roller * 0.7 + fine * 0.3
    _build_set("paint_wall", S, None, rough, 0.0, height, 0.4, color_field=col)

    # --- metal_brushed 512: dark anisotropic streaks, roughness ~0.4, METALLIC 0.9 ---
    rng = np.random.default_rng(TEX_SEED + 6)
    streak = 0.5 + 0.5 * np.sin(2 * np.pi * gy * 220.0)
    streak = streak * 0.4 + 0.6 * _fine_noise(rng, S)
    # horizontal blur to make streaks anisotropic (average along x, wrap)
    k = 9
    acc = np.zeros_like(streak)
    for off in range(-k, k + 1):
        acc += np.roll(streak, off, axis=1)
    streak = acc / (2 * k + 1)
    base_metal = np.array([0.30, 0.30, 0.33])
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = np.clip(base_metal[c] * (0.7 + 0.6 * streak), 0, 1)
    rough = np.full((S, S), 0.40) + (streak - 0.5) * 0.15
    height = streak
    # Normal strength lowered 0.5->0.35 so the 220-cycle brushed streaks do not
    # shimmer on the small metal parts (handles, lamp, chair) at viewing distance.
    _build_set("metal_brushed", S, None, rough, 0.90, height, 0.35, color_field=col)

    # --- metal_dark 512: near-black flat plastic/metal for the task chair and
    # the window frame/sill. Low-frequency subtle sheen only (no high-freq
    # streaks -> no shimmer). roughness ~0.5, metallic ~0.3. ---
    rng = np.random.default_rng(TEX_SEED + 11)
    mottle = _wrap_noise(rng, S, 4, 3)
    fine = _fine_noise(rng, S)
    dark = np.array([0.055, 0.058, 0.065])       # near-black, faint cool tint
    col = np.empty((S, S, 3))
    shade = 0.85 + 0.30 * mottle
    for c in range(3):
        col[..., c] = np.clip(dark[c] * shade + 0.010, 0, 1)
    rough = np.full((S, S), 0.50) + (mottle - 0.5) * 0.10
    height = mottle * 0.7 + fine * 0.3
    _build_set("metal_dark", S, None, rough, 0.30, height, 0.30, color_field=col)

    # ------------------------------------------------------------------
    # Decor colorways (M1 lived-in staging). Deterministic seeds +7..+9.
    # All procedurally authored (rule 9) — no downloads, no reference art.
    # ------------------------------------------------------------------

    # --- fabric_heather 512: gray-blue heather duvet — like fabric_navy but
    # lighter/desaturated with a melange speckle, roughness ~0.9 ---
    rng = np.random.default_rng(TEX_SEED + 7)
    # Weave frequency HALVED (48->24) and normal strength lowered (0.9->0.5) to
    # kill moire shimmer on the duvet at viewing distance.
    weave = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 24.0) * np.sin(2 * np.pi * gy * 24.0)
    speck = _fine_noise(rng, S)
    speck2 = _wrap_noise(rng, S, 24, 3)          # coarser melange blotches
    heather = np.array([0.46, 0.52, 0.60])       # desaturated gray-blue
    col = np.empty((S, S, 3))
    for c in range(3):
        col[..., c] = heather[c] * (0.90 + 0.16 * weave)
    # melange: push flecks toward lighter gray and slightly darker blue
    col += (speck[..., None] - 0.5) * 0.10        # bright/dark yarn flecks
    col += (speck2[..., None] - 0.5) * 0.05       # soft tonal drift
    rough = np.full((S, S), 0.90) + (weave - 0.5) * 0.05
    height = weave * 0.5 + speck * 0.5
    _build_set("fabric_heather", S, None, rough, 0.0, height, 0.5, color_field=col)

    # --- rug_woven 512: warm gray, coarser weave than carpet, roughness ~0.92 ---
    rng = np.random.default_rng(TEX_SEED + 8)
    # coarse over-under basket weave: lower spatial frequency than fabric weave
    warp_th = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 26.0)
    weft_th = 0.5 + 0.5 * np.sin(2 * np.pi * gy * 26.0)
    weave = np.maximum(warp_th, weft_th)          # raised threads read coarse
    grit = _fine_noise(rng, S)
    low = _wrap_noise(rng, S, 6, 3)
    warm_gray = np.array([0.52, 0.49, 0.45])      # warm (slightly red/yellow) gray
    col = np.empty((S, S, 3))
    shade = 0.82 + 0.24 * weave + 0.08 * (low - 0.5)
    for c in range(3):
        col[..., c] = np.clip(warm_gray[c] * shade, 0, 1)
    col += (grit[..., None] - 0.5) * 0.03
    rough = np.full((S, S), 0.92) + (weave - 0.5) * 0.04
    height = weave * 0.7 + grit * 0.3
    _build_set("rug_woven", S, None, rough, 0.0, height, 1.2, color_field=col)

    # --- curtain_weave 512: warm tan/gold (muted golden beige), matching the
    # official video still's drapes -- much warmer/deeper than the old
    # off-white linen. Fine weave, roughness ~0.85. ---
    rng = np.random.default_rng(TEX_SEED + 9)
    weave = 0.5 + 0.5 * np.sin(2 * np.pi * gx * 80.0) * np.sin(2 * np.pi * gy * 80.0)
    fine = _fine_noise(rng, S)
    # deepened toward amber/ochre so the drapes stand apart from the maple
    # furniture and white walls while remaining visually distinct
    gold = np.array([0.62, 0.44, 0.22])
    col = np.empty((S, S, 3))
    shade = 0.90 + 0.14 * weave + 0.03 * (fine - 0.5)
    for c in range(3):
        col[..., c] = np.clip(gold[c] * shade, 0, 1)
    rough = np.full((S, S), 0.85) + (weave - 0.5) * 0.05
    height = weave * 0.6 + fine * 0.4
    _build_set("curtain_weave", S, None, rough, 0.0, height, 0.6, color_field=col)

    # --- sky_backdrop 512: soft vertical gradient, pale blue (top) -> near
    # white (near the sill), for the window backdrop plane's EMISSION texture.
    # Procedurally generated (numpy), never sourced from a reference image. ---
    S3 = 512
    ys3 = np.linspace(0.0, 1.0, S3)
    rng = np.random.default_rng(TEX_SEED + 12)
    # Row 0 = image top (see _save_png), sampled at V=1. The backdrop plane
    # carries explicit stretched UVs (v = normalized world Z, one tile spans
    # the whole plane — see _uv_stretch_xz / audit F11), so blue-at-row-0
    # renders as deep blue at the sky top -> pale at the horizon.
    grad = ys3[::-1][:, None] * np.ones((1, S3))     # 1 at top row, 0 at bottom row
    haze = _wrap_noise(rng, S3, 6, 3)
    # richer blue up top so the glass doesn't blow out to white under the
    # viewer's ACES exposure (visual polish pass)
    sky_top = np.array([0.42, 0.62, 0.90])
    sky_bottom = np.array([0.88, 0.93, 0.97])
    col = np.empty((S3, S3, 3))
    for c in range(3):
        col[..., c] = np.clip(
            sky_bottom[c] + (sky_top[c] - sky_bottom[c]) * grad + (haze - 0.5) * 0.02,
            0, 1)
    _save_png(col, os.path.join(_TEXDIR, "sky_backdrop_emissive.png"))


# --------------------------------------------------------------------------
# glTF-safe material wiring (ORM Separate Color pattern)
# --------------------------------------------------------------------------

def _load_img(name, colorspace):
    path = os.path.join(_TEXDIR, name)
    img = bpy.data.images.load(path, check_existing=False)
    img.name = Path(name).stem
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    _IMAGES.append(img)
    return img


def make_textured_mat(name, normal_strength=0.6):
    """Wire a glTF-exporter-recognised PBR material from the generated set:
       basecolor(sRGB)->Base Color; ORM(Non-Color)->Separate Color G/B ->
       Roughness/Metallic; normal(Non-Color)->Normal Map->Normal.
    The Separate Color path is the canonical pattern glTF-Blender-IO repacks
    into a metallicRoughnessTexture."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (600, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (300, 0)
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    base_img = _load_img(f"{name}_basecolor.png", "sRGB")
    orm_img = _load_img(f"{name}_orm.png", "Non-Color")
    nrm_img = _load_img(f"{name}_normal.png", "Non-Color")

    tex_base = nodes.new("ShaderNodeTexImage")
    tex_base.image = base_img
    tex_base.location = (-300, 200)
    links.new(tex_base.outputs["Color"], bsdf.inputs["Base Color"])

    tex_orm = nodes.new("ShaderNodeTexImage")
    tex_orm.image = orm_img
    tex_orm.location = (-300, -100)
    sep = nodes.new("ShaderNodeSeparateColor")
    sep.location = (0, -100)
    links.new(tex_orm.outputs["Color"], sep.inputs["Color"])
    links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])

    tex_nrm = nodes.new("ShaderNodeTexImage")
    tex_nrm.image = nrm_img
    tex_nrm.location = (-300, -400)
    nmap = nodes.new("ShaderNodeNormalMap")
    nmap.location = (0, -400)
    nmap.inputs["Strength"].default_value = normal_strength
    links.new(tex_nrm.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    return mat


def make_glass_mat(name):
    """Flat glass material: cool light-blue tint, low alpha, near-mirror-smooth
    roughness so it reads as glazing (not a pale slab) against the sky backdrop
    plane behind it."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.62, 0.78, 0.92, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.05
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Alpha"].default_value = 0.20
    mat.blend_method = "BLEND"
    return mat


def make_sky_backdrop_mat(name, img):
    """Emissive-only material for the window sky backdrop plane: baseColor is
    black (no diffuse contribution) and the gradient texture drives EMISSION at
    ~1.2 strength, so the plane self-illuminates regardless of scene lights and
    casts no shadow-affecting surface response. This is the glTF-safe way to
    get a shadeless "sky glow" that survives export (glTF supports the KHR
    emissive-strength extension via Blender's emission Strength input)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nodes, links = nt.nodes, nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (400, 0)
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (100, 0)
    bsdf.inputs["Base Color"].default_value = (0.0, 0.0, 0.0, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    tex = nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.location = (-250, 0)
    links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.3

    return mat


def make_materials(room=None):
    global _MATERIALS
    sky_img = _load_img("sky_backdrop_emissive.png", "sRGB")
    _MATERIALS = {
        "wood_walnut": make_textured_mat("wood_walnut"),
        "wood_maple": make_textured_mat("wood_maple"),
        "laminate_light": make_textured_mat("laminate_light"),
        "fabric_navy": make_textured_mat("fabric_navy"),
        "carpet_blue": make_textured_mat("carpet_blue"),
        "paint_wall": make_textured_mat("paint_wall"),
        "metal_brushed": make_textured_mat("metal_brushed"),
        "metal_dark": make_textured_mat("metal_dark"),
        "fabric_heather": make_textured_mat("fabric_heather"),
        "rug_woven": make_textured_mat("rug_woven"),
        "curtain_weave": make_textured_mat("curtain_weave"),
        "glass": make_glass_mat("glass"),
        "sky_backdrop": make_sky_backdrop_mat("sky_backdrop", sky_img),
    }
    if is_standard_double(room or {}):
        _MATERIALS["carpet_charcoal"] = make_textured_mat("carpet_charcoal")
    return _MATERIALS


# --------------------------------------------------------------------------
# Dimension resolution
# --------------------------------------------------------------------------

def dim_value(dim, fallback):
    if isinstance(dim, dict) and dim.get("value_m") is not None:
        return float(dim["value_m"]), dim.get("status", "verified")
    return fallback, "estimated_placeholder"


def object_dimensions(obj, defaults):
    dims = obj.get("dimensions_m") or {}
    x, xs = dim_value(dims.get("x"), defaults[0])
    y, ys = dim_value(dims.get("y"), defaults[1])
    z, zs = dim_value(dims.get("z"), defaults[2])
    status = obj.get("dimension_status", "unknown")
    if "estimated_placeholder" in [xs, ys, zs] and status == "unknown":
        status = "estimated"
    return (x, y, z), status


def room_geometry_axis(room, axis):
    """Resolve one shell axis from verified measurements or visualization data.

    room_shell is the public measurement surface, so only a positive, verified,
    non-estimated value is usable here. visualization_shell is the required
    geometry-only fallback and remains explicitly estimated in exported extras.
    """
    measured = room.get("room_shell", {}).get(axis)
    if (
        isinstance(measured, dict)
        and measured.get("status") == "verified"
        and measured.get("estimated") is False
        and measured.get("value_m") is not None
    ):
        value = float(measured["value_m"])
        if math.isfinite(value) and value > 0:
            return value, measured, "room_shell"

    visual = room.get("visualization_shell", {}).get(axis)
    if not isinstance(visual, dict) or visual.get("value_m") is None:
        raise ValueError(
            f"Room {room.get('display_name', '<unknown>')} has no usable {axis} geometry."
        )
    value = float(visual["value_m"])
    if (
        not math.isfinite(value)
        or value <= 0
        or visual.get("status") != "estimated"
        or visual.get("estimated") is not True
        or not visual.get("source_id")
    ):
        raise ValueError(
            f"Room {room.get('display_name', '<unknown>')} has invalid "
            f"visualization_shell.{axis}."
        )
    return value, visual, "visualization_shell"


def custom_props(room, source_obj=None, dimension_status="estimated"):
    source_obj = source_obj or {}
    return {
        "school": room.get("school"),
        "hall": room.get("hall"),
        "room_type": room.get("room_type"),
        "accuracy_tier": room.get("accuracy_tier"),
        "representative_model": str(room.get("representative_model")),
        "source_id": source_obj.get("source_id"),
        "confidence": source_obj.get("confidence"),
        "dimension_status": dimension_status,
        "estimated_dimensions_warning":
            "Do not treat estimated dimensions as verified Berkeley measurements.",
    }


def decor_props(room, attached_to=None):
    """Custom props for a lived-in-staging (decor) mesh. Carries the standard 9
    keys PLUS `decorative: "true"`, a `notes` honesty string, and — for items
    that sit on a piece of furniture — an `attached_to` furniture group prefix
    so the viewer can follow that furniture's visibility.

    dimension_status stays "estimated" (a known schema enum value); the
    illustrative-only caveat lives in `notes`.
    """
    props = custom_props(
        room, {"source_id": "decor", "confidence": "low"}, "estimated"
    )
    props["decorative"] = "true"
    props["notes"] = "Illustrative only; not included with the room."
    if attached_to is not None:
        props["attached_to"] = attached_to
    return props


# --------------------------------------------------------------------------
# Geometry helper — beveled, UV-projected, textured, metadata-baked box
# --------------------------------------------------------------------------

def _apply_props(obj, custom):
    if not custom:
        return
    for k, v in custom.items():
        obj[k] = v if v is not None else ""


def beveled_box(name, size, loc, mat, collection, custom,
                bevel_width=None, rot=None, uv_tile=0.75, smooth=True):
    """Create a cube sized to `size`, apply scale, cube-project UVs for roughly
    uniform texel density (~1 tile per uv_tile metres), add a small Bevel
    modifier, shade smooth (Blender 5.x guard), assign material, and bake the
    custom-property metadata onto the object so coverage is automatic.

    Modifiers bake at export via export_apply=True.
    """
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    if rot:
        obj.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=bool(rot), scale=True)

    # Cube-project UVs. cube_size is in the projected space; pick it so one
    # texture tile covers ~uv_tile metres of surface.
    max_dim = max(size) if max(size) > 0 else 1.0
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=uv_tile)
    bpy.ops.object.mode_set(mode="OBJECT")

    # Bevel modifier — small so it reads as a chamfered edge, not a round.
    if bevel_width is None:
        bevel_width = 0.015 if max_dim >= 0.6 else 0.008
    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = bevel_width
    bev.segments = 2
    bev.limit_method = "ANGLE"
    bev.angle_limit = math.radians(40)

    if smooth:
        try:
            # Mark faces smooth and sharp edges directly. Unlike
            # shade_auto_smooth(), this does not add Blender's linked
            # "Smooth by Angle" Geometry Nodes asset to the saved file.
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        except Exception:
            try:
                bpy.ops.object.shade_smooth()
            except Exception:
                pass

    if mat:
        obj.data.materials.append(mat)
    link_to_collection(obj, collection)
    _apply_props(obj, custom)
    return obj


# --------------------------------------------------------------------------
# Room shell
# --------------------------------------------------------------------------

WALL_T = 0.08


def build_shell(room, mats):
    resolved = {
        axis: room_geometry_axis(room, axis)
        for axis in ("width", "depth", "height")
    }
    width, depth, height = (resolved[axis][0] for axis in ("width", "depth", "height"))
    dimensions = {axis: resolved[axis][1] for axis in resolved}
    bases = {axis: resolved[axis][2] for axis in resolved}
    shell_status = (
        "verified"
        if all(basis == "room_shell" for basis in bases.values())
        else "estimated"
    )

    confidence_order = {"unknown": 0, "low": 1, "medium": 2, "high": 3}
    shell_confidence = min(
        (dimension.get("confidence", "unknown") for dimension in dimensions.values()),
        key=lambda value: confidence_order.get(value, 0),
    )
    source_ids = [dimension.get("source_id") for dimension in dimensions.values()]
    props = custom_props(
        room,
        {"source_id": source_ids[0], "confidence": shell_confidence},
        shell_status,
    )
    props.update({
        "geometry_basis": (
            next(iter(bases.values()))
            if len(set(bases.values())) == 1
            else "mixed"
        ),
        "width_source_id": dimensions["width"].get("source_id"),
        "depth_source_id": dimensions["depth"].get("source_id"),
        "height_source_id": dimensions["height"].get("source_id"),
        "width_geometry_basis": bases["width"],
        "depth_geometry_basis": bases["depth"],
        "height_geometry_basis": bases["height"],
    })

    # Floor / ceiling
    floor_mat = mats["carpet_charcoal"] if is_standard_double(room) else mats["carpet_blue"]
    beveled_box("floor", (width, depth, 0.05), (0, 0, -0.025),
                floor_mat, "RoomShell", props, uv_tile=1.0)
    beveled_box("ceiling", (width, depth, 0.04), (0, 0, height),
                mats["paint_wall"], "RoomShell", props, uv_tile=1.0)

    # Walls — names and centroid x/z are LOAD-BEARING for the viewer WallCuller.
    # Each wall is extended CONTACT_EPS below the floor (bottom at -eps, top at
    # `height`) so the wall bottom never shares the floor-top (z=0) plane; the
    # centroid z shifts by only eps/2, well within WallCuller tolerance.
    e = CONTACT_EPS
    wz = height + e
    wcz = height / 2 - e / 2
    walls = {
        "wall_back_window": ((width, WALL_T, wz), (0, depth / 2, wcz)),
        "wall_entry":       ((width, WALL_T, wz), (0, -depth / 2, wcz)),
        "wall_left":        ((WALL_T, depth, wz), (-width / 2, 0, wcz)),
        "wall_right":       ((WALL_T, depth, wz), (width / 2, 0, wcz)),
    }
    wall_objs = {}
    for wname, (wsize, wloc) in walls.items():
        wall_objs[wname] = beveled_box(
            wname, wsize, wloc, mats["paint_wall"], "RoomShell", props, uv_tile=1.0
        )

    return width, depth, height, wall_objs, props


# --------------------------------------------------------------------------
# Wall openings (boolean cut) + door / window / trim, parented to walls
# --------------------------------------------------------------------------

def _boolean_cut(target, cutter):
    """DIFFERENCE cutter out of target, EXACT solver, apply, delete cutter.
    Does NOT move the target origin. Raises on failure."""
    bpy.context.view_layer.objects.active = target
    mod = target.modifiers.new("Cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def _parent_keep(child, parent):
    """Parent child to a wall with keep-transform so it hides with the wall in
    the dollhouse view (constraint 3)."""
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


def _uv_stretch_xz(obj):
    """Remap the object's UVs so ONE texture tile spans its full world X/Z
    bounds (u = normalized X, v = normalized Z, so V=1 is the world top).
    Used by the window sky backdrop: cube-projected UVs tile ~1/metre, which
    REPEATED the sky gradient ~1.8x across the plane and rendered it as
    horizontal bands instead of one top-to-bottom gradient (audit F11)."""
    me = obj.data
    uv = me.uv_layers.active
    if uv is None:
        return
    mw = obj.matrix_world
    coords = [mw @ v.co for v in me.vertices]
    xs = [c.x for c in coords]
    zs = [c.z for c in coords]
    x0, z0 = min(xs), min(zs)
    sx = (max(xs) - x0) or 1.0
    sz = (max(zs) - z0) or 1.0
    for loop in me.loops:
        c = coords[loop.vertex_index]
        uv.data[loop.index].uv = ((c.x - x0) / sx, (c.z - z0) / sz)


def _make_cutter(size, loc):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    c = bpy.context.object
    c.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return c


def door_center_x(room, W):
    """Entry-door centre X per the official Unit 3 3D layout views
    (unit3_interior_model_pack_2026_07): the TRIPLE's door sits at the
    upper-left corner of the entry wall (closets fill the wall right of
    it); the DOUBLE's door is centered with a closet in each corner."""
    door = next((o for o in room["objects"] if o["type"] == "door"), None)
    (dx, _, _), _ = object_dimensions(door or {}, (0.91, 0.04, 2.05))
    has_loft = any(o["type"] == "loft_bed" for o in room["objects"])
    if has_loft:
        # hug the left corner: wall face + casing (0.05) + a small reveal
        return -W / 2 + WALL_T + 0.05 + 0.05 + dx / 2
    return 0.0


def build_openings(room, mats, W, D, H, wall_objs, shell_props):
    door = next((o for o in room["objects"] if o["type"] == "door"), None)
    window = next((o for o in room["objects"] if o["type"] == "window"), None)

    # ---- Door in wall_entry (y = -D/2) ----
    if door:
        (dx, dy, dz), status = object_dimensions(door, (0.91, 0.04, 2.05))
        props = custom_props(room, door, status)
        cx = door_center_x(room, W)
        wall = wall_objs["wall_entry"]
        # boolean reveal
        try:
            cutter = _make_cutter((dx, WALL_T * 2.5, dz),
                                  (cx, -D / 2, dz / 2))
            _boolean_cut(wall, cutter)
        except Exception as e:  # pragma: no cover
            print(f"WARN: door boolean cut failed ({e}); using glued-on look.")

        # leaf slightly inset into the reveal
        leaf = beveled_box("door_1_leaf", (dx - 0.04, 0.04, dz - 0.04),
                           (cx, -D / 2 + 0.005, dz / 2), mats["wood_walnut"],
                           "Doors", props, uv_tile=0.7)
        _parent_keep(leaf, wall)
        # casing frame (four thin bars around the reveal). The side casings are
        # lifted CONTACT_EPS off the floor so their bottom face never shares the
        # floor's z=0 plane (z-fight).
        cw = 0.05
        casing_h = dz - CONTACT_EPS
        casing_parts = [
            ("door_1_casing_top", (dx + 2 * cw, 0.05, cw), (cx, -D / 2, dz + cw / 2)),
            ("door_1_casing_left", (cw, 0.05, casing_h),
             (cx - dx / 2 - cw / 2, -D / 2, CONTACT_EPS + casing_h / 2)),
            ("door_1_casing_right", (cw, 0.05, casing_h),
             (cx + dx / 2 + cw / 2, -D / 2, CONTACT_EPS + casing_h / 2)),
        ]
        for cn, cs, cl in casing_parts:
            part = beveled_box(cn, cs, cl, mats["paint_wall"], "Doors", props, uv_tile=0.5)
            _parent_keep(part, wall)
        # round handle
        bpy.ops.mesh.primitive_cylinder_add(radius=0.03, depth=0.06,
                                            location=(cx + dx / 2 - 0.10, -D / 2 + 0.09, dz * 0.45),
                                            rotation=(math.radians(90), 0, 0))
        handle = bpy.context.object
        handle.name = "door_1_handle"
        handle.data.materials.append(mats["metal_brushed"])
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        except Exception:
            bpy.ops.object.shade_smooth()
        link_to_collection(handle, "Doors")
        _apply_props(handle, props)
        _parent_keep(handle, wall)

    # ---- Window in wall_back_window (y = +D/2) ----
    if window:
        (wx, wy, wz), status = object_dimensions(window, (1.8, 0.04, 1.2))
        props = custom_props(room, window, status)
        sill_h = 0.55
        wall = wall_objs["wall_back_window"]
        try:
            cutter = _make_cutter((wx, WALL_T * 2.5, wz),
                                  (0, D / 2, sill_h + wz / 2))
            _boolean_cut(wall, cutter)
        except Exception as e:  # pragma: no cover
            print(f"WARN: window boolean cut failed ({e}); using glued-on look.")

        # Glass. The canonical double is a two-bay assembly with a real centre
        # mullion; other room types retain the original single pane.
        fw = 0.05
        if is_standard_double(room):
            pane_w = (wx - 0.06 - fw) / 2.0
            pane_offset = (pane_w + fw) / 2.0
            for tag, sx in (("left", -1.0), ("right", 1.0)):
                pane = beveled_box(
                    f"window_1_glass_{tag}", (pane_w, 0.02, wz - 0.06),
                    (sx * pane_offset, D / 2, sill_h + wz / 2),
                    mats["glass"], "Windows", props, uv_tile=0.6, smooth=False,
                )
                _parent_keep(pane, wall)
        else:
            pane = beveled_box("window_1_glass", (wx - 0.06, 0.02, wz - 0.06),
                              (0, D / 2, sill_h + wz / 2), mats["glass"],
                              "Windows", props, uv_tile=0.6, smooth=False)
            _parent_keep(pane, wall)

        # Frame — dark bronze/near-black metal per the references.
        frame_parts = [
            ("window_1_frame_top", (wx + 2 * fw, 0.06, fw), (0, D / 2, sill_h + wz + fw / 2)),
            ("window_1_frame_bottom", (wx + 2 * fw, 0.06, fw), (0, D / 2, sill_h - fw / 2)),
            ("window_1_frame_left", (fw, 0.06, wz + 2 * fw), (-wx / 2 - fw / 2, D / 2, sill_h + wz / 2)),
            ("window_1_frame_right", (fw, 0.06, wz + 2 * fw), (wx / 2 + fw / 2, D / 2, sill_h + wz / 2)),
        ]
        if is_standard_double(room):
            frame_parts.append(
                ("window_1_frame_center", (fw, 0.065, wz + 2 * fw),
                 (0, D / 2 - CONTACT_EPS, sill_h + wz / 2))
            )
        for fn, fs, fl in frame_parts:
            part = beveled_box(fn, fs, fl, mats["metal_dark"], "Windows", props, uv_tile=0.5)
            _parent_keep(part, wall)
        # sill — dark metal; nudged CONTACT_EPS toward the room so its back face
        # embeds in the wall instead of sharing the inner wall plane.
        sill = beveled_box("window_1_sill", (wx + 0.14, 0.14, 0.04),
                          (0, D / 2 - 0.03 - CONTACT_EPS, sill_h - 0.04), mats["metal_dark"],
                          "Windows", props, uv_tile=0.5)
        _parent_keep(sill, wall)

        # Sky backdrop: a thin emissive plane ~0.15 m OUTSIDE the window
        # opening (beyond the exterior wall face), slightly larger than the
        # opening, so looking through the glass from inside reads as soft sky
        # instead of void. trim_ prefix -> no furniture group; parented to
        # wall_back_window so it hides with that wall in the dollhouse view.
        # Emissive material (see make_sky_backdrop_mat) means it self-lights
        # and does not need/cast scene shadows.
        backdrop_margin = 0.20
        backdrop_y = D / 2 + WALL_T / 2 + 0.15
        backdrop = beveled_box(
            "trim_window_backdrop",
            (wx + backdrop_margin, 0.02, wz + backdrop_margin),
            (0, backdrop_y, sill_h + wz / 2),
            mats["sky_backdrop"], "Windows", props, uv_tile=1.0, smooth=False,
        )
        # one gradient tile spans the whole plane, V up (audit F11)
        _uv_stretch_xz(backdrop)
        _parent_keep(backdrop, wall)

        # Record window geometry so curtains derive from the same variables and
        # parent to the same wall (they must hide with it in the dollhouse view).
        global _WINDOW
        _WINDOW = {
            "cx": 0.0, "wx": wx, "wz": wz, "sill": sill_h,
            "top": sill_h + wz, "wall_y": D / 2, "wall": wall,
        }

    # ---- Baseboards along each wall floor seam (parented to each wall). Each is
    # nudged CONTACT_EPS INTO its wall (back face embedded, not coplanar) and
    # lifted CONTACT_EPS off the floor so no baseboard shares the wall-inner or
    # floor-top plane. ----
    bb_props = shell_props
    bh = 0.09
    bt = 0.02
    e = CONTACT_EPS
    bz = e + bh / 2                       # lifted off the floor
    entry_y = -D / 2 + WALL_T / 2 + bt / 2 - e
    baseboards = {
        "wall_back_window": [("trim_baseboard_back", (W, bt, bh), (0, D / 2 - WALL_T / 2 - bt / 2 + e, bz))],
        "wall_left": [("trim_baseboard_left", (bt, D, bh), (-W / 2 + WALL_T / 2 + bt / 2 - e, 0, bz))],
        "wall_right": [("trim_baseboard_right", (bt, D, bh), (W / 2 - WALL_T / 2 - bt / 2 + e, 0, bz))],
    }
    if door:
        # Split the entry strip at the door casing -- a continuous board would
        # run across the doorway in front of the closed leaf.
        cas_l = cx - dx / 2 - 0.05
        cas_r = cx + dx / 2 + 0.05
        baseboards["wall_entry"] = [
            ("trim_baseboard_entry_l", (cas_l - (-W / 2), bt, bh),
             ((-W / 2 + cas_l) / 2, entry_y, bz)),
            ("trim_baseboard_entry_r", (W / 2 - cas_r, bt, bh),
             ((cas_r + W / 2) / 2, entry_y, bz)),
        ]
    else:
        baseboards["wall_entry"] = [("trim_baseboard_entry", (W, bt, bh), (0, entry_y, bz))]
    for wname, segs in baseboards.items():
        wall = wall_objs[wname]
        for bn, bs, bl in segs:
            part = beveled_box(bn, bs, bl, mats["wood_maple"], "RoomShell", bb_props, uv_tile=0.6)
            _parent_keep(part, wall)

    # ---- Radiator under the window (parented to wall_back_window so it culls
    # with that wall). The double has a paired convector under its two window
    # bays; the triple retains its established single centred unit. trim_
    # prefix => no furniture group. ----
    if window:
        rad_wall = wall_objs["wall_back_window"]
        win_wx = _WINDOW["wx"] if _WINDOW else 1.8
        rad_h = 0.40                                   # stays clear below the lowered sill
        rad_d = 0.10
        rad_bottom = 0.10                              # off the floor a little
        rad_y = D / 2 - WALL_T / 2 - rad_d / 2 - e     # face just inside the wall
        rprops = shell_props

        def radiator_group(tag, rad_cx, rad_w, n_fin):
            suffix = f"_{tag}" if tag else ""
            back = beveled_box(
                f"trim_radiator{suffix}_back", (rad_w, rad_d * 0.4, rad_h),
                (rad_cx, rad_y + rad_d * 0.3, rad_bottom + rad_h / 2),
                mats["metal_brushed"], "RoomShell", rprops, uv_tile=0.4,
            )
            _parent_keep(back, rad_wall)
            fin_w = 0.02
            span = rad_w - 0.06
            for k in range(n_fin):
                fx = rad_cx - span / 2 + k * (span / (n_fin - 1))
                fin = beveled_box(
                    f"trim_radiator{suffix}_fin_{k + 1}",
                    (fin_w, rad_d, rad_h - 0.04),
                    (fx, rad_y, rad_bottom + (rad_h - 0.04) / 2),
                    mats["metal_brushed"], "RoomShell", rprops, uv_tile=0.3,
                )
                _parent_keep(fin, rad_wall)

        if is_standard_double(room):
            rad_w = min(win_wx * 0.35, 1.30)
            rad_offset = win_wx * 0.25
            radiator_group("left", -rad_offset, rad_w, 9)
            radiator_group("right", rad_offset, rad_w, 9)
            aggregate_left = -rad_offset - rad_w / 2
            aggregate_right = rad_offset + rad_w / 2
            _WINDOW["radiators"] = [
                {"cx": -rad_offset, "w": rad_w},
                {"cx": rad_offset, "w": rad_w},
            ]
            _WINDOW["rad_left"] = aggregate_left
            _WINDOW["rad_cx"] = 0.0
            _WINDOW["rad_w"] = aggregate_right - aggregate_left
        else:
            # Existing triple behavior: a compact single centred radiator.
            rad_w = min(win_wx * 0.60, 0.90)
            rad_cx = 0.0
            radiator_group("", rad_cx, rad_w, 11)
            _WINDOW["rad_left"] = rad_cx - rad_w / 2
            _WINDOW["rad_cx"] = rad_cx
            _WINDOW["rad_w"] = rad_w
        _WINDOW["rad_front_y"] = rad_y - rad_d / 2   # fin front face (room side)


# --------------------------------------------------------------------------
# Furniture builders (multi-part, parametric off dimensions_m)
# --------------------------------------------------------------------------

def _chair(prefix, cx, cy, dims, mats, props, face=1.0, axis="y", ground=0.0):
    """Black rolling TASK CHAIR (dark near-black plastic/metal).

    Parts: 5-spoke star base (rotated thin boxes) + caster cylinders, a central
    gas-lift cylinder, a padded seat slab, and a curved/tilted backrest on a
    short back-bar.

    `face` is the +/-1 direction (along `axis`) that the BACKREST sits, i.e. the
    room side; the open front of the seat then points toward the desk. `axis` is
    "y" for a window-wall desk (back along +/-y) or "x" for the under-loft desk
    (back along +/-x, so the chair faces the left wall).

    All heights derive from `dims` (chair footprint x,y and total height z).
    `ground` is the world-Z of the surface the casters rest on (0 = floor
    top). The casters are
    horizontal cylinders, so their vertical half-extent is the RADIUS — they
    are centred at ground + eps + radius so the wheels rest on the surface
    with a CONTACT_EPS gap instead of sinking through it (audit F8).
    """
    x, y, z = dims
    dark = mats["metal_dark"]
    e = CONTACT_EPS
    caster_r = 0.022
    caster_h = 0.030
    base_z = ground + e + caster_h           # bottom of spokes
    spoke_len = min(x, y) * 0.52
    spoke_t = 0.028
    spoke_h = 0.022
    # 5-spoke star base — thin boxes rotated about Z, offset outward from centre
    for k in range(5):
        ang = k * (2.0 * math.pi / 5.0)
        mid_r = spoke_len * 0.5
        sx = cx + mid_r * math.cos(ang)
        sy = cy + mid_r * math.sin(ang)
        beveled_box(f"{prefix}_base_spoke_{k+1}", (spoke_len, spoke_t, spoke_h),
                    (sx, sy, base_z + spoke_h / 2), dark, "Furniture", props,
                    bevel_width=0.004, rot=(0, 0, ang), uv_tile=0.25)
        # caster at the spoke tip, wheel resting on `ground` + eps
        tip_r = spoke_len * 0.92
        _cyl(f"{prefix}_caster_{k+1}", caster_r, caster_h,
             (cx + tip_r * math.cos(ang), cy + tip_r * math.sin(ang),
              ground + e + caster_r), dark, props,
             rot=(math.radians(90), 0, 0), verts=12, collection="Furniture")
    # central gas-lift column
    seat_h = ground + z * 0.52
    column_top = seat_h
    column_bot = base_z + spoke_h
    _cyl(f"{prefix}_gaslift", 0.028, column_top - column_bot,
         (cx, cy, (column_top + column_bot) / 2.0), dark, props,
         verts=14, collection="Furniture")
    # padded seat slab (dark upholstery look via metal_dark)
    seat_t = 0.06
    beveled_box(f"{prefix}_seat", (x, y, seat_t), (cx, cy, seat_h + seat_t / 2),
                dark, "Furniture", props, bevel_width=0.02, uv_tile=0.35)
    # short vertical back-bar rising from the rear of the seat, then the backrest
    # slab tilted back a little. Rear is toward `face` along `axis`.
    if axis == "y":
        back_off = face * (y / 2 - 0.03)
        bar_loc = (cx, cy + back_off, seat_h + seat_t + 0.06)
        bar_size = (x * 0.30, 0.04, 0.14)
        rest_h = ground + z - (seat_h + seat_t + 0.12)
        rest_z = seat_h + seat_t + 0.12 + rest_h / 2
        rest_size = (x * 0.92, 0.05, rest_h)
        rest_loc = (cx, cy + back_off + face * 0.02, rest_z)
        rest_rot = (math.radians(face * 8.0), 0, 0)
    else:  # axis == "x"
        back_off = face * (x / 2 - 0.03)
        bar_loc = (cx + back_off, cy, seat_h + seat_t + 0.06)
        bar_size = (0.04, y * 0.30, 0.14)
        rest_h = ground + z - (seat_h + seat_t + 0.12)
        rest_z = seat_h + seat_t + 0.12 + rest_h / 2
        rest_size = (0.05, y * 0.92, rest_h)
        rest_loc = (cx + back_off + face * 0.02, cy, rest_z)
        rest_rot = (0, math.radians(-face * 8.0), 0)
    beveled_box(f"{prefix}_backbar", bar_size, bar_loc, dark, "Furniture", props,
                bevel_width=0.01, uv_tile=0.25)
    beveled_box(f"{prefix}_backrest", rest_size, rest_loc, dark, "Furniture", props,
                bevel_width=0.02, rot=rest_rot, uv_tile=0.35)


def _wood_chair(prefix, cx, cy, dims, mats, props, face=1.0, axis="y", ground=0.0):
    """Simple fixed wood dorm chair used by the canonical double only.

    Direct double walkthroughs show straight maple chairs rather than the
    rolling task chairs visible in the triple reference photography. The seat
    node keeps the same `chair_N_seat` contract used by placement validation and
    Arrange-mode grouping; all other parts remain under the same instance prefix.
    """
    x, y, z = dims
    e = CONTACT_EPS
    wood = mats["wood_maple"]
    seat_mat = mats["fabric_navy"]
    seat_z = ground + min(0.46, z * 0.53)
    seat_t = 0.055
    seat_x = x * 0.90
    seat_y = y * 0.90
    beveled_box(
        f"{prefix}_seat", (seat_x, seat_y, seat_t),
        (cx, cy, seat_z), seat_mat, "Furniture", props,
        bevel_width=0.012, uv_tile=0.35,
    )

    # Four square legs taper visually by staying narrow; their tops embed in
    # the seat slab, avoiding a floating-chair seam.
    leg_t = 0.045
    leg_h = seat_z - seat_t / 2.0 - ground - e
    for sx in (-1.0, 1.0):
        for sy in (-1.0, 1.0):
            beveled_box(
                f"{prefix}_leg_{'l' if sx < 0 else 'r'}_{'back' if sy > 0 else 'front'}",
                (leg_t, leg_t, leg_h),
                (cx + sx * (seat_x / 2 - leg_t / 2),
                 cy + sy * (seat_y / 2 - leg_t / 2),
                 ground + e + leg_h / 2),
                wood, "Furniture", props, bevel_width=0.006, uv_tile=0.3,
            )

    # Two tall rear posts and two horizontal rails. `face` identifies the side
    # away from the desk (the chair back), matching `_chair` semantics.
    back_top = ground + z
    post_h = back_top - (seat_z - seat_t / 2)
    if axis == "y":
        back_y = cy + face * (seat_y / 2 - leg_t / 2)
        post_locs = [
            (cx - seat_x / 2 + leg_t / 2, back_y),
            (cx + seat_x / 2 - leg_t / 2, back_y),
        ]
        post_size = (leg_t, leg_t, post_h)
        rail_size = (seat_x - 2 * leg_t, 0.04, 0.055)
        rail_xy = (cx, back_y)
    else:
        back_x = cx + face * (seat_x / 2 - leg_t / 2)
        post_locs = [
            (back_x, cy - seat_y / 2 + leg_t / 2),
            (back_x, cy + seat_y / 2 - leg_t / 2),
        ]
        post_size = (leg_t, leg_t, post_h)
        rail_size = (0.04, seat_y - 2 * leg_t, 0.055)
        rail_xy = (back_x, cy)
    for idx, (px, py) in enumerate(post_locs, start=1):
        beveled_box(
            f"{prefix}_back_post_{idx}", post_size,
            (px, py, seat_z - seat_t / 2 + post_h / 2),
            wood, "Furniture", props, bevel_width=0.006, uv_tile=0.3,
        )
    for idx, rz in enumerate((seat_z + post_h * 0.48, seat_z + post_h * 0.76), start=1):
        beveled_box(
            f"{prefix}_back_rail_{idx}", rail_size,
            (rail_xy[0], rail_xy[1], rz),
            wood, "Furniture", props, bevel_width=0.008, uv_tile=0.35,
        )


def _desk(idx, px, py, desk_wl, mats, dprops, face, axis="y",
          record_desk1=False, hutch=False, hutch_h=0.0, hutch_inline=True,
          mirror_u=False):
    """Build one desk (multi-part) + tuck a task chair at it. Orientation-aware.

    `mirror_u=True` flips the along-wall (`u`) placement of every ASYMMETRIC
    part (pedestal, drawers, hutch clearance side reservation) so the
    pedestal sits at the -wall-span end instead of +. Used when two desks
    share the same `py`/`px` reference line and would otherwise both put
    their pedestal at the same along-wall position (e.g. two desks facing
    each other across a centre aisle at the same Y).

    `hutch`/`hutch_h` reserve a wall-side clearance depth for a low shelf
    hutch (so decor items on the OPEN front half never collide with one) even
    when the hutch geometry itself is built elsewhere. `hutch_inline=False`
    skips building the small single-desk hutch box here — used by the triple
    layout, where one continuous hutch spans both under-loft desks instead
    (see `_continuous_hutch`).

    Geometry in the desk's LOCAL frame: `dw` = span along the wall (the desktop
    width), `dd` = depth away from the wall, `dz` = height. For a window-wall
    desk (`axis="y"`) the wall is at +/-Y so dw runs along X and dd along Y. For
    an under-loft desk against the LEFT wall (`axis="x"`) dw runs along Y and dd
    along X; the desk is rotated 90 deg so its long axis parallels the wall.

    `face` is the +/-1 direction (along the depth axis) pointing from the desk
    toward the room interior (the chair/knee-well side). The pedestal sits at the
    +wall-axis end of the desktop; the chair tucks on the `face` side, seat
    overlapping the desktop front edge, backrest on the room side, and the whole
    chair rotated to face the desk.
    """
    dw, dd, dz = desk_wl        # width-along-wall, depth, height
    top_t = 0.04
    top_z = dz - top_t / 2
    panel_t = 0.03
    e = CONTACT_EPS
    pfx = f"desk_{idx}"

    # Map local (along-wall `u`, depth `v`) to world (x, y) for this orientation.
    if axis == "y":
        def box(name, u_size, v_size, z_size, u, v, z, mat, uv):
            beveled_box(name, (u_size, v_size, z_size), (px + u, py + v, z),
                        mat, "Furniture", dprops, uv_tile=uv)
        wall_span, depth = dw, dd
    else:  # axis == "x": swap so `u` (along-wall) is Y and `v` (depth) is X
        def box(name, u_size, v_size, z_size, u, v, z, mat, uv):
            beveled_box(name, (v_size, u_size, z_size), (px + v, py + u, z),
                        mat, "Furniture", dprops, uv_tile=uv)
        wall_span, depth = dw, dd

    # ---- desktop ----
    box(f"{pfx}_top", wall_span, depth, top_t, 0, 0, top_z, mats["laminate_light"], 0.7)

    # ---- two wood side panels (light maple) at the wall-span ends, lifted
    # CONTACT_EPS off the floor so their bottom never shares the floor plane ----
    side_h = dz - top_t - e
    for su in (-1, 1):
        box(f"{pfx}_side_{su}", panel_t, depth, side_h,
            su * (wall_span / 2 - panel_t / 2), 0, e + side_h / 2,
            mats["wood_maple"], 0.6)

    # ---- modesty panel across the back (wall side, opposite `face`) ----
    mod_h = (dz - top_t) * 0.6
    box(f"{pfx}_modesty", wall_span - 2 * panel_t, 0.02, mod_h,
        0, -face * (depth / 2 - 0.02), mod_h / 2 + 0.10, mats["wood_maple"], 0.6)

    # ---- 3-drawer pedestal at the +wall-span end ----
    ped_w = dw * 0.32
    mirror_sign = -1.0 if mirror_u else 1.0
    ped_u = mirror_sign * (wall_span / 2 - ped_w / 2 - panel_t)
    carcass_h = dz - top_t - 0.02
    box(f"{pfx}_drawer_carcass", ped_w, depth - 0.04, carcass_h,
        ped_u, 0, e + carcass_h / 2, mats["wood_maple"], 0.5)   # lifted off floor
    drawer_h = (dz - top_t - 0.06) / 3
    front_v = face * (depth / 2 - 0.01)         # fronts flush at the room-side face
    for d in range(3):
        fz = 0.03 + drawer_h / 2 + d * drawer_h
        box(f"{pfx}_drawer_{d+1}_front", ped_w - 0.03, 0.02, drawer_h - 0.012,
            ped_u, front_v, fz, mats["laminate_light"], 0.4)
        # handle pushed proud of the front so it never shares the carcass plane
        box(f"{pfx}_drawer_{d+1}_handle", ped_w * 0.5, 0.02, 0.014,
            ped_u, front_v + face * (0.02 + e), fz, mats["metal_brushed"], 0.2)

    # ---- optional low shelf hutch on the wall side of the desktop (single-desk
    # inline version; skipped when a continuous multi-desk hutch is built by
    # the caller instead, i.e. hutch_inline=False) ----
    if hutch and hutch_h > 0 and hutch_inline:
        hu_depth = min(0.30, depth * 0.5)
        # hutch sits on the desktop, against the back (wall) edge
        base = top_z + top_t / 2 + e            # just above the desktop surface
        hu_v = -face * (depth / 2 - hu_depth / 2)   # against wall side
        # two side panels
        for su in (-1, 1):
            box(f"{pfx}_hutch_side_{su}", panel_t, hu_depth, hutch_h,
                su * (wall_span / 2 - panel_t / 2), hu_v, base + hutch_h / 2,
                mats["wood_maple"], 0.5)
        # back panel
        box(f"{pfx}_hutch_back", wall_span - 2 * panel_t, 0.02, hutch_h,
            0, -face * (depth / 2 - 0.02), base + hutch_h / 2, mats["wood_maple"], 0.5)
        # top + one mid shelf (lifted CONTACT_EPS off any shared plane)
        box(f"{pfx}_hutch_top", wall_span - 2 * panel_t, hu_depth, 0.02,
            0, hu_v, base + hutch_h - 0.01, mats["wood_maple"], 0.5)
        box(f"{pfx}_hutch_shelf", wall_span - 2 * panel_t, hu_depth - 0.02, 0.018,
            0, hu_v, base + hutch_h * 0.5, mats["wood_maple"], 0.5)

    rec = {
        "cx": px, "cy": py,
        "top": top_z + top_t / 2,
        "w": dw, "d": dd, "face": face, "axis": axis,
        # keep the hutch clearance zone so decor stays on the OPEN front half
        "hutch": bool(hutch and hutch_h > 0),
        "hutch_depth": (min(0.30, dd * 0.5) if (hutch and hutch_h > 0) else 0.0),
    }
    _ALL_DESKS.append(rec)
    if record_desk1:
        # Record this desk so the decor pass sits items on its exact top surface.
        # The decor pass places along the desk's LOCAL width axis; we store the
        # orientation so it can map local->world too.
        global _DESK1
        _DESK1 = rec


def _continuous_hutch(px, py1, py2, desk_wl, mats, dprops, face, hutch_h, axis="x"):
    """ONE long low shelf hutch spanning two edge-to-edge under-loft desks
    (butted at their shared midpoint, identical top height, no gap), against
    the wall, fitting under the raised loft platform.

    `py1`/`py2` are the two desks' along-wall centres (same convention as
    `_desk`'s `py` for axis="x"); the hutch spans continuously from the outer
    edge of desk 1 to the outer edge of desk 2. Parts are split at the shared
    midpoint into `desk_1_hutch_*` (the half over desk 1) and `desk_2_hutch_*`
    (the half over desk 2) so each half still carries its own desk's identity
    for the viewer's furniture grouping.
    """
    dw, dd, dz = desk_wl
    top_t = 0.04
    top_z = dz - top_t / 2
    panel_t = 0.03
    e = CONTACT_EPS

    if axis == "x":
        def box(name, u_size, v_size, z_size, u, v, z, mat, uv):
            beveled_box(name, (v_size, u_size, z_size), (px + v, u, z),
                        mat, "Furniture", dprops, uv_tile=uv)
        depth = dd
    else:
        def box(name, u_size, v_size, z_size, u, v, z, mat, uv):
            beveled_box(name, (u_size, v_size, z_size), (u, px + v, z),
                        mat, "Furniture", dprops, uv_tile=uv)
        depth = dd

    span_total = 2 * dw            # two desks butted edge-to-edge, no gap
    mid_u = (py1 + py2) / 2.0      # shared seam between the two desks
    outer1 = min(py1, py2) - dw / 2.0
    outer2 = max(py1, py2) + dw / 2.0

    hu_depth = min(0.30, depth * 0.5)
    base = top_z + top_t / 2 + e             # just above the desktop surface
    hu_v = -face * (depth / 2 - hu_depth / 2)  # against the wall side

    # Continuous back panel + top + mid shelf spanning the FULL width (no seam
    # gap — this is the "continuous" nook), split into two half-length parts
    # each named for its own desk so furniture identity/grouping is preserved.
    half = span_total / 2.0
    for tag, u_center in (("desk_1", outer1 + half / 2.0), ("desk_2", outer2 - half / 2.0)):
        box(f"{tag}_hutch_back", half, 0.02, hutch_h,
            u_center, -face * (depth / 2 - 0.02), base + hutch_h / 2,
            mats["wood_maple"], 0.5)
        box(f"{tag}_hutch_top", half, hu_depth, 0.02,
            u_center, hu_v, base + hutch_h - 0.01, mats["wood_maple"], 0.5)
        box(f"{tag}_hutch_shelf", half - 0.01, hu_depth - 0.02, 0.018,
            u_center, hu_v, base + hutch_h * 0.5, mats["wood_maple"], 0.5)

    # End panels at the two outer ends only (no panel at the shared midpoint —
    # that is what makes the nook read as one continuous piece).
    box("desk_1_hutch_side_outer", panel_t, hu_depth, hutch_h,
        outer1 + panel_t / 2, hu_v, base + hutch_h / 2, mats["wood_maple"], 0.5)
    box("desk_2_hutch_side_outer", panel_t, hu_depth, hutch_h,
        outer2 - panel_t / 2, hu_v, base + hutch_h / 2, mats["wood_maple"], 0.5)


def _tuck_chair(idx, px, py, desk_wl, chair_wl, mats, cprops, face, axis="y",
                 mirror_u=False, extra_pullback=0.0, ground=0.0, wood=False):
    """Place a chair tucked at the desk knee-well: centred on the open
    knee area, seat overlapping the desktop front edge by ~0.12 m, backrest on
    the room side, rotated to face the desk. `mirror_u` must match the same
    flag passed to the paired `_desk()` call (pedestal on the -wall-span end
    instead of +), so the knee-well stays on the OPEN side, not the pedestal.
    `extra_pullback` shrinks how far the chair extends past the desk's own
    depth footprint (beyond the default ~0.105 m) -- used when two desks face
    each other across a narrow aisle so the chairs don't reach past the
    centreline into each other."""
    dw, dd, dz = desk_wl
    chx, chy, chz = chair_wl
    overlap = 0.12 + extra_pullback
    ped_w = dw * 0.32
    mirror_sign = -1.0 if mirror_u else 1.0
    # knee-well centre is offset from the pedestal end, toward the -wall-span end
    knee_u = -mirror_sign * (ped_w / 2)      # shift away from the pedestal
    chair_builder = _wood_chair if wood else _chair
    if axis == "y":
        # depth axis is Y; chair sits on the `face` (interior) Y side
        knee_cx = px + knee_u
        chair_cy = py + face * (dd / 2 + chy / 2 - overlap)
        chair_builder(f"chair_{idx}", knee_cx, chair_cy, (chx, chy, chz),
                      mats, cprops, face=face, axis="y", ground=ground)
    else:
        # depth axis is X; chair sits on the `face` (interior) X side
        chair_cx = px + face * (dd / 2 + chx / 2 - overlap)
        knee_cy = py + knee_u
        chair_builder(f"chair_{idx}", chair_cx, knee_cy, (chx, chy, chz),
                      mats, cprops, face=face, axis="x", ground=ground)


def build_chairs_and_desks(room, mats, W, D):
    global _WINDOW_DESK, _OPEN_FLOOR_Y_HI
    desk = next((o for o in room["objects"] if o["type"] == "desk"), None)
    chair = next((o for o in room["objects"] if o["type"] == "chair"), None)
    if not desk:
        return
    (dx, dy, dz), desk_status = object_dimensions(desk, (1.05, 0.61, 0.76))
    (chx, chy, chz), chair_status = object_dimensions(chair or {}, (0.45, 0.45, 0.85))
    count = desk.get("count", 1)
    desk_wl = (dx, dy, dz)
    chair_wl = (chx, chy, chz)
    has_loft = any(o["type"] == "loft_bed" for o in room["objects"])

    def dprops():
        return custom_props(room, desk, desk_status)

    def cprops():
        return custom_props(room, chair, chair_status)

    if has_loft and count >= 3:
        # ---- Triple (official depiction): TWO desks under the loft along the
        # LEFT wall facing it, third desk on the window wall. ----
        # Loft is at cx = -W/2 + by/2 + 0.10 (by placeholder); the row's cy
        # puts the bed HEAD at the window, same derivation as build_loft_bed.
        loft = next(o for o in room["objects"] if o["type"] == "loft_bed")
        (lbx, lby, _), _ = object_dimensions(loft, (2.03, 0.99, 1.75))
        loft_cx = -W / 2 + lby / 2 + 0.10
        loft_cy = bed_head_at_window_y(D, lbx)
        loft_bz = dim_value(loft.get("dimensions_m", {}).get("z"), 1.75)[0]
        loft_plat_z = loft_bz - LOFT_PLATFORM_OFFSET
        loft_plat_t = 0.06
        # platform boards sit PLATFORM_DROP below the fascia top (see
        # build_loft_bed / audit F2)
        loft_plat_underside = loft_plat_z - PLATFORM_DROP - loft_plat_t

        # Under-loft desks: rotated (axis="x"), against the left wall, facing +x
        # (room interior). Width dx runs along Y; place two side-by-side. The
        # depth (dy) runs along X; nudge the desks off the wall far enough that
        # their backs clear the loft's wall-side posts (which sit at the corners
        # against the same wall) rather than interpenetrating them.
        wall_face_x = -W / 2 + WALL_T
        loft_post_front_x = loft_cx - (lby / 2 - BED_POST / 2) + BED_POST / 2  # interior face
        udesk_px = max(wall_face_x + dy / 2 + 0.02,
                       loft_post_front_x + dy / 2 + 0.02)   # depth (dy) runs along X
        # CONTINUOUS STUDY NOOK: butt the two desks edge-to-edge (no gap), same
        # top height (identical desk_wl for both), so the desktops read as one
        # unbroken run under the loft platform. Each desk's run-width is
        # capped to half the loft length so the nook stays entirely inside
        # the loft's footprint (the entry-side floor is the door zone).
        nook_w = min(dx, lbx / 2.0)
        nook_desk_wl = (nook_w, desk_wl[1], desk_wl[2])
        # a CONTACT_EPS-wide seam between the two desks so no hutch/top face
        # plane is exactly shared (z-fight rule); still reads as one run
        seam = 2 * CONTACT_EPS
        u_positions = [loft_cy - (nook_w + seam) / 2.0,
                       loft_cy + (nook_w + seam) / 2.0]
        # low hutch: fits under the loft platform AND stays CONTACT_EPS clear
        # of the fascia band's bottom edge, which hangs FASCIA_H below the
        # fascia top — the hutch previously grazed it by 2.5 mm (audit F6).
        # The hutch base sits at desk top + CONTACT_EPS (see _desk).
        avail = loft_plat_underside - dz - 0.04
        fascia_clear = (loft_plat_z - FASCIA_H) - CONTACT_EPS - (dz + CONTACT_EPS)
        hutch_h = max(0.0, min(0.60, avail, fascia_clear))
        for j, uy in enumerate(u_positions):
            _desk(j + 1, udesk_px, uy, nook_desk_wl, mats, dprops(),
                  face=+1, axis="x", record_desk1=(j == 0),
                  hutch=True, hutch_h=hutch_h, hutch_inline=False)
            if chair:
                # extra tuck: the window-side nook chair's pulled-out casters
                # otherwise graze the window-wall desk's side panel corner
                _tuck_chair(j + 1, udesk_px, uy, nook_desk_wl, chair_wl,
                            mats, cprops(), face=+1, axis="x",
                            extra_pullback=0.06)
        if hutch_h > 0:
            _continuous_hutch(udesk_px, u_positions[0], u_positions[1], nook_desk_wl,
                               mats, dprops(), face=+1, hutch_h=hutch_h, axis="x")

        # Third desk against the window wall between the two bed heads,
        # facing the window (official views + layout text), CENTERED on the
        # window (canonical layout: the window desk sits in the middle of the
        # window wall). The desk overlaps the radiator's X span, so the wall
        # stand-off clears the fin FRONT face instead of the nominal 0.12.
        rad_left = _WINDOW["rad_left"] if _WINDOW and "rad_left" in _WINDOW else -0.10
        rad_right = (_WINDOW["rad_cx"] + _WINDOW["rad_w"] / 2.0
                     if _WINDOW and "rad_w" in _WINDOW else 0.45)
        rad_front = (_WINDOW["rad_front_y"]
                     if _WINDOW and "rad_front_y" in _WINDOW else D / 2 - 0.15)
        w3_px = _WINDOW["cx"] if _WINDOW else 0.0
        w3_py = D / 2 - dy / 2 - 0.12
        if (w3_px + dx / 2) > rad_left - 0.02 and (w3_px - dx / 2) < rad_right + 0.02:
            w3_py = min(w3_py, rad_front - dy / 2 - 0.02)
        _desk(3, w3_px, w3_py, desk_wl, mats, dprops(),
              face=-1, axis="y", record_desk1=False, hutch=False)
        if chair:
            _tuck_chair(3, w3_px, w3_py, desk_wl, chair_wl,
                        mats, cprops(), face=-1, axis="y")
        # Record the desk's right edge so build_storage can slot dresser_2
        # beside it on the window wall (official photo: low drawer unit at
        # the window wall right of centre), and the open floor's window-side
        # limit (desk front minus its pulled-out chair zone) for the rug.
        _WINDOW_DESK = {"x_max": w3_px + dx / 2, "py": w3_py}
        _OPEN_FLOOR_Y_HI = w3_py - dy / 2 - 0.55
        return

    twin = next((o for o in room["objects"] if o["type"] == "twin_xl_bed"), None)
    if twin and count >= 2 and is_standard_double(room):
        # ---- Double (official floorplan + official high-rise walkthrough):
        # ONE narrow TANDEM desk line on x=0. The two desks are end-to-end on
        # the window<->entry axis, not doubled side-by-side across the room.
        # Desk 1 is the window-side station accessed from the LEFT bed aisle;
        # desk 2 is entry-side and accessed from the RIGHT. ----
        layout = _twin_bed_layout(room, W, D)
        tby = layout["tby"]
        head_y = layout["head_y"]          # window-wall end of the beds
        foot_y = layout["foot_y"]          # entry end of the beds
        inner_gap = 0.06                   # clearance from each bed's inner edge
        inner_left = layout["left_cx"] + tby / 2.0 + inner_gap
        inner_right = layout["right_cx"] - tby / 2.0 - inner_gap
        island_depth = min(dy, inner_right - inner_left)
        island_len = min(dx, (head_y - foot_y + 0.08) / 2.0)
        seam = 2 * CONTACT_EPS
        tandem_total = 2 * island_len + seam
        bed_mid_y = (head_y + foot_y) / 2.0
        # If the broad paired radiators overlap the desk's narrow centre strip,
        # shift the whole tandem line entryward just enough to preserve a real
        # gap; otherwise centre it on the bed run.
        window_limit = (
            _WINDOW["rad_front_y"] - 0.03
            if _WINDOW and "rad_front_y" in _WINDOW
            else D / 2 - WALL_T / 2 - 0.12
        )
        tandem_mid_y = min(bed_mid_y, window_limit - tandem_total / 2.0)
        station_offset = (island_len + seam) / 2.0

        desk_specs = [
            (1, -1, tandem_mid_y + station_offset, False, dprops()),
            (2, +1, tandem_mid_y - station_offset, True, dprops()),
        ]
        for idx, face, desk_cy, mirror_u, dp in desk_specs[:min(count, 2)]:
            desk_cx = 0.0
            desk_wl_i = (island_len, island_depth, dz)
            _desk(idx, desk_cx, desk_cy, desk_wl_i, mats, dp,
                  face=face, axis="x", record_desk1=(idx == 1), hutch=False,
                  mirror_u=mirror_u)
            if chair:
                _tuck_chair(idx, desk_cx, desk_cy, desk_wl_i, chair_wl,
                            mats, cprops(), face=face, axis="x",
                            mirror_u=mirror_u, extra_pullback=0.04, wood=True)
        # open floor for the rug: everything south (entry side) of the island
        _OPEN_FLOOR_Y_HI = tandem_mid_y - tandem_total / 2.0 - 0.05
        # Any additional desks beyond the 2-desk island fall back to the
        # window-wall line (rare: schema with >2 desks and twin beds).
        extra = count - 2
        if extra > 0:
            py = D / 2 - dy / 2 - 0.12
            left = -W / 2 + dx / 2 + 0.12
            right = W / 2 - dx / 2 - 0.12
            step = (right - left) / (extra - 1) if extra > 1 else 0.0
            for k in range(extra):
                idx = 2 + k + 1
                px = left + k * step
                _desk(idx, px, py, desk_wl, mats, dprops(), face=-1, axis="y", hutch=False)
                if chair:
                    _tuck_chair(idx, px, py, desk_wl, chair_wl, mats, cprops(),
                                face=-1, axis="y")
        return

    # ---- Fallback (no-loft room with no twin beds recognised, or count<2):
    # desks line the window wall, left-to-right, stopping short of the
    # Microchill corner. Chairs tuck toward room centre. The Microchill
    # clearance is derived from its OWN schema footprint (same formula
    # build_storage uses: px = W/2 - mx/2 - 0.15) rather than a flat reserve
    # constant, so there is genuine room for each desk position to also dodge
    # the radiator footprint (from the recorded _WINDOW descriptor). ----
    py = D / 2 - dy / 2 - 0.12
    face = -1
    micro = next((o for o in room["objects"] if o["type"] == "microchill"), None)
    (mx, _, _), _ = object_dimensions(micro or {}, (0.48, 0.50, 0.86))
    micro_left = W / 2 - mx - 0.15   # left edge of the Microchill footprint
    left = -W / 2 + dx / 2 + 0.12
    right = min(W / 2 - dx / 2 - 0.06, micro_left - dx / 2 - 0.06)
    step = (right - left) / (count - 1) if count > 1 else 0.0
    rad_left = _WINDOW["rad_left"] if _WINDOW and "rad_left" in _WINDOW else None
    rad_right = (_WINDOW["rad_cx"] + _WINDOW["rad_w"] / 2.0) if _WINDOW and "rad_w" in _WINDOW else None
    for i in range(count):
        px = left + i * step
        if rad_left is not None and rad_right is not None:
            desk_left, desk_right = px - dx / 2, px + dx / 2
            overlaps_rad = desk_right > rad_left and desk_left < rad_right
            if overlaps_rad:
                # Nudge clear of the radiator only if a clean slot exists on
                # EITHER side without colliding with an already-placed desk
                # (checked against the true previous desk position, not just
                # the room's outer left/right bounds). If the room is too
                # narrow for a collision-free nudge (visualization estimates
                # can be tight), leave the desk at its evenly-stepped spot
                # rather than push it into a worse, NEW desk-vs-desk overlap.
                to_right = rad_right + dx / 2 + 0.06
                to_left = rad_left - dx / 2 - 0.06
                prev_right = (left + (i - 1) * step) + dx / 2 if i > 0 else None
                if to_right <= right:
                    px = to_right
                elif to_left >= left and (prev_right is None or to_left - dx / 2 >= prev_right):
                    px = to_left
        _desk(i + 1, px, py, desk_wl, mats, dprops(),
              face=face, axis="y", record_desk1=(i == 0), hutch=False)
        if chair:
            _tuck_chair(i + 1, px, py, desk_wl, chair_wl,
                        mats, cprops(), face=face, axis="y")


# Sleeping-surface descriptors collected during furniture build, consumed by the
# decor pass. Each entry records the mattress footprint + top height + the
# furniture GROUP prefix it belongs to, so bed dressing derives from the exact
# same parametric layout the mattress used (no hardcoded coordinates).
_SLEEP_SURFACES = []


def _mattress(surface_id, group, cx, cy, top_z, bx, by, mats, props,
              mattress_bevel=0.04, pillow_toward=1.0, dress_x_limits=None):
    """A soft mattress (larger bevel). Records a sleeping-surface descriptor so
    the decor pass can lay bed dressing (duvet + pillows) on top of it.

    NOTE: pillows are now DECOR, not furniture — hiding decor reveals a bare
    mattress. The mattress itself stays furniture.

    Box sizing is unchanged from the original builder: X extent = bx*0.96,
    Y extent = by*0.94 (callers pass their own width/length in those slots).
    `pillow_toward` is the +/- y direction of the head end.
    `dress_x_limits` (min_x, max_x) is an optional world-X clamp for the bed
    DRESSING (duvet): posted beds pass their posts' inner faces so a draped
    duvet never slices through a corner post (audit F7).
    """
    mt = 0.16
    ext_x = bx * 0.96    # mattress extent along world X
    ext_y = by * 0.94    # mattress extent along world Y
    # Lift CONTACT_EPS so the mattress bottom never shares the frame/platform-top
    # plane (z-fight); the small gap reads as bedding, not a floating mattress.
    base = top_z + CONTACT_EPS
    beveled_box(f"{surface_id}_mattress", (ext_x, ext_y, mt),
                (cx, cy, base + mt / 2), mats["fabric_navy"], "Furniture", props,
                bevel_width=mattress_bevel, uv_tile=0.6)
    _SLEEP_SURFACES.append({
        "surface_id": surface_id,        # e.g. loft_bed_1, bunk_bed_1_upper
        "group": group,                  # loft_bed | bunk_bed | twin_xl_bed
        "cx": cx, "cy": cy,
        "top": base + mt,                # world-Z of the mattress top surface
        "ext_x": ext_x,                  # mattress extent along X
        "ext_y": ext_y,                  # mattress extent along Y
        "head_toward": pillow_toward,    # +/-1: y-direction of the head end
        "dress_x_limits": dress_x_limits,  # optional duvet X clamp (posts)
    })


LADDER_LEAN_DEG = 12.0        # lean off vertical, matching the reference photos
LADDER_STILE_W = 0.09         # wide flat stile (was a thin 0.04 square post)
LADDER_STILE_T = 0.028
LADDER_RUNG_SPAN = 0.35       # clear span between stile inner faces
LADDER_RUNG_D = 0.07          # flat rung depth (front-to-back)
LADDER_RUNG_T = 0.028
LADDER_RUNGS = 5


def _ladder(prefix, x0, y0, z_top, mats, props, rungs=LADDER_RUNGS, lean_sign=1.0,
            fascia_h=0.0, orient="x"):
    """Chunky flat oak ladder: two wide flat stiles + flat rungs, leaning
    ~LADDER_LEAN_DEG off vertical so the top hooks over the bed platform's
    fascia board. `(x0, y0)` is the floor contact point (base of the stiles,
    on the room-interior side); the ladder leans back by `lean_sign` along the
    lean axis so its top overlaps/touches the fascia at `z_top` (the fascia
    board's top edge), matching the photos where the ladder top tucks over
    the platform trim instead of floating in front of it.

    `orient` selects the lean axis: "x" = stiles spaced along Y, top drifts
    lean_sign along X (a SIDE-fascia ladder); "y" = stiles spaced along X,
    top drifts lean_sign along Y (a FOOT-fascia ladder — audit F1).

    Stiles run the full lean from floor to z_top + a little overlap into the
    fascia band so the top visually connects (no gap). Rungs are flat boards
    (not round dowels) mortised between the stiles, evenly spaced.
    """
    e = CONTACT_EPS
    lean = math.radians(LADDER_LEAN_DEG)
    # total climbed height reaching a bit INTO the fascia band so the top of
    # the stile overlaps the fascia face rather than stopping short of it.
    reach = z_top + min(fascia_h * 0.6, 0.12) - e
    stile_len = reach / math.cos(lean)          # true length along the lean
    stile_gap = LADDER_STILE_W + LADDER_RUNG_SPAN  # centre-to-centre of stiles
    mid_h = reach / 2.0
    mid_off = lean_sign * mid_h * math.tan(lean)   # lean-axis drift at mid height
    if orient == "x":
        rot = (0.0, lean_sign * lean, 0.0)
        stile_size = (LADDER_STILE_T, LADDER_STILE_W, stile_len)
        rung_size = (LADDER_RUNG_D, LADDER_RUNG_SPAN, LADDER_RUNG_T)
        for sy in (-1, 1):
            beveled_box(f"{prefix}_stile_{sy}", stile_size,
                        (x0 + mid_off, y0 + sy * stile_gap / 2, e + mid_h),
                        mats["wood_maple"], "Furniture", props, bevel_width=0.006,
                        rot=rot, uv_tile=0.25)
        for r in range(rungs):
            rh = (r + 1) / (rungs + 1) * reach
            beveled_box(f"{prefix}_rung_{r+1}", rung_size,
                        (x0 + lean_sign * rh * math.tan(lean), y0, e + rh),
                        mats["wood_maple"], "Furniture", props,
                        bevel_width=0.006, rot=rot, uv_tile=0.2)
    else:  # orient == "y"
        rot = (-lean_sign * lean, 0.0, 0.0)
        stile_size = (LADDER_STILE_W, LADDER_STILE_T, stile_len)
        rung_size = (LADDER_RUNG_SPAN, LADDER_RUNG_D, LADDER_RUNG_T)
        for sx in (-1, 1):
            beveled_box(f"{prefix}_stile_{sx}", stile_size,
                        (x0 + sx * stile_gap / 2, y0 + mid_off, e + mid_h),
                        mats["wood_maple"], "Furniture", props, bevel_width=0.006,
                        rot=rot, uv_tile=0.25)
        for r in range(rungs):
            rh = (r + 1) / (rungs + 1) * reach
            beveled_box(f"{prefix}_rung_{r+1}", rung_size,
                        (x0, y0 + lean_sign * rh * math.tan(lean), e + rh),
                        mats["wood_maple"], "Furniture", props,
                        bevel_width=0.006, rot=rot, uv_tile=0.2)


FASCIA_H = 0.22        # deep flat fascia board around platform edges (0.20-0.24 spec)
FASCIA_T = 0.05
BED_POST = 0.09        # square posts, up from the old 0.06 thin post
GUARDRAIL_H = 0.15     # wide flat guardrail board, up from the old 0.04x0.22 stick
LOFT_PLATFORM_OFFSET = 0.17   # bz - this = fascia-top height (~1.58 at bz=1.75)
# Loft/bunk platform boards sit this far BELOW the fascia top, so the seated
# mattress (bottom = platform top + CONTACT_EPS) half-hides behind the fascia
# band like the reference photos instead of floating above it (audit F2).
PLATFORM_DROP = 0.08

# Clear depth kept in front of the entry door for its swing (audit F3 standard;
# the leaf itself is ~0.87, 0.90 gives margin).
DOOR_SWING_CLEAR = 0.90


def bed_head_at_window_y(D, bed_len):
    """Bed-row centre Y with the HEAD at the window wall.

    The official Unit 3 3D layout views and the official room photo
    (unit3_interior_model_pack_2026_07) put EVERY bed head tight to the
    window wall in both room types. The head face lands at the window
    baseboard face minus CONTACT_EPS; the radiator is centered under the
    window and does not reach the side-wall bed positions in X.
    """
    head_face = D / 2 - WALL_T / 2 - 0.02 - CONTACT_EPS
    return head_face - bed_len / 2


def build_loft_bed(room, mats, W, D):
    obj = next((o for o in room["objects"] if o["type"] == "loft_bed"), None)
    if not obj:
        return
    (bx, by, bz), status = object_dimensions(obj, (2.03, 0.99, 1.75))
    props = custom_props(room, obj, status)
    # Along the LEFT wall, HEAD at the window (official views/photo put both
    # beds' heads tight to the window wall); length (bx) runs along y.
    cx = -W / 2 + by / 2 + 0.10
    cy = bed_head_at_window_y(D, bx)
    plat_z = bz - LOFT_PLATFORM_OFFSET     # ~1.58 at the bz=1.75 placeholder
    post = BED_POST
    e = CONTACT_EPS
    post_h = bz - e
    # 4 posts (light wood, squarer section), lifted CONTACT_EPS off the floor
    for sx in (-1, 1):
        for sy in (-1, 1):
            beveled_box(f"loft_bed_1_post_{sx}_{sy}", (post, post, post_h),
                        (cx + sx * (by / 2 - post / 2), cy + sy * (bx / 2 - post / 2),
                         e + post_h / 2),
                        mats["wood_maple"], "Furniture", props, uv_tile=0.3)
    # deep flat fascia board around the platform edge (head/foot/sides) so the
    # mattress lower half sits hidden inside it, like the reference photos.
    # Fascia hangs BELOW the platform top (plat_z) by FASCIA_H, top flush with
    # the platform surface.
    fascia_top = plat_z
    fascia_cz = fascia_top - FASCIA_H / 2
    # head fascia at the WINDOW (+y) end, foot fascia at the entry (-y) end
    beveled_box("loft_bed_1_fascia_head", (by, FASCIA_T, FASCIA_H),
                (cx, cy + bx / 2 - FASCIA_T / 2, fascia_cz),
                mats["wood_maple"], "Furniture", props, uv_tile=0.4)
    beveled_box("loft_bed_1_fascia_foot", (by, FASCIA_T, FASCIA_H),
                (cx, cy - bx / 2 + FASCIA_T / 2, fascia_cz),
                mats["wood_maple"], "Furniture", props, uv_tile=0.4)
    for sx in (-1, 1):
        beveled_box(f"loft_bed_1_fascia_side_{sx}", (FASCIA_T, bx, FASCIA_H),
                    (cx + sx * (by / 2 - FASCIA_T / 2), cy, fascia_cz),
                    mats["wood_maple"], "Furniture", props, uv_tile=0.4)
    # platform boards PLATFORM_DROP below the fascia top (plat_z), so the
    # seated mattress half-hides behind the fascia band (audit F2)
    plat_t = 0.06
    plat_top = plat_z - PLATFORM_DROP
    beveled_box("loft_bed_1_platform", (by, bx, plat_t), (cx, cy, plat_top - plat_t / 2),
                mats["laminate_light"], "Furniture", props, uv_tile=0.6)
    # guardrail on the open (interior +x) side: wide flat board biased to
    # the HEAD half, leaving the foot end open where the side ladder hooks
    # (real loft rails leave the climb-in gap; also keeps the leaning stile
    # tips clear of the rail)
    beveled_box("loft_bed_1_guardrail", (0.04, bx * 0.55, GUARDRAIL_H),
                (cx + by / 2 - 0.02, cy + bx * 0.15, plat_z + GUARDRAIL_H / 2 + 0.02),
                mats["wood_maple"], "Furniture", props, uv_tile=0.4)
    # mattress seated on the platform boards, inset INSIDE the fascia
    # boards (not interpenetrating them) so the ladder's hook tips clear
    # its edge; pillows/duvet added later as decor with duvet X extents
    # clamped to the posts' inner faces (audit F7)
    _mattress("loft_bed_1", "loft_bed", cx, cy, plat_top,
              by - 2 * FASCIA_T - 2 * e, bx - 2 * FASCIA_T - 2 * e, mats, props,
              pillow_toward=+1.0,
              dress_x_limits=(cx - (by / 2 - post) + e, cx + (by / 2 - post) - e))
    # Ladder on the room-centre (+x) SIDE near the FOOT (entry) end, like
    # the bunk's — leaning so its top hooks over the loft's side fascia
    # (audit F1: >=20 mm stile/fascia AABB overlap via the 0.328 base
    # stand-off). This keeps the loft-foot floor corner free for the
    # dresser the official view places there.
    # base y = foot + 0.40 keeps the near stile's full y-band clear of the
    # foot corner post's band (post 0.09 deep; stile half-width 0.045)
    ladder_base_x = cx + by / 2 + 0.328
    ladder_y = cy - bx / 2 + 0.40
    _ladder("loft_bed_1_ladder", ladder_base_x, ladder_y, plat_z, mats, props,
            lean_sign=-1.0, fascia_h=FASCIA_H)
    # Record the stiles' X envelope for downstream clearance checks.
    global _LOFT_LADDER
    _LOFT_LADDER = {"x_max": ladder_base_x + LADDER_STILE_T}


def build_bunk_bed(room, mats, W, D):
    obj = next((o for o in room["objects"] if o["type"] == "bunk_bed"), None)
    if not obj:
        return
    (bx, by, bz), status = object_dimensions(obj, (2.03, 0.99, 1.75))
    props = custom_props(room, obj, status)
    # Along the RIGHT wall, HEAD at the window (official views/photo).
    cx = W / 2 - by / 2 - 0.10
    cy = bed_head_at_window_y(D, bx)
    post = BED_POST
    e = CONTACT_EPS
    lower_z = 0.42
    upper_z = 1.42
    # shared 4 posts full height (light wood, squarer section), lifted
    # CONTACT_EPS off the floor
    post_h = upper_z + 0.55 - e
    for sx in (-1, 1):
        for sy in (-1, 1):
            beveled_box(f"bunk_bed_1_post_{sx}_{sy}", (post, post, post_h),
                        (cx + sx * (by / 2 - post / 2), cy + sy * (bx / 2 - post / 2),
                         e + post_h / 2),
                        mats["wood_maple"], "Furniture", props, uv_tile=0.3)
    # per-level deep flat fascia around the platform edge (mattress lower half
    # sits hidden inside it, matching the reference photos). Fascia top is
    # flush with the platform surface (zc); it hangs down FASCIA_H.
    fascia_h_bunk = min(FASCIA_H, (upper_z - lower_z) - 0.10)   # keep clear of the bunk below
    for level, zc in (("lower", lower_z), ("upper", upper_z)):
        fascia_cz = zc - fascia_h_bunk / 2
        # head fascia at the WINDOW (+y) end, foot fascia at the entry (-y) end
        beveled_box(f"bunk_bed_1_{level}_fascia_head", (by, FASCIA_T, fascia_h_bunk),
                    (cx, cy + bx / 2 - FASCIA_T / 2, fascia_cz),
                    mats["wood_maple"], "Furniture", props, uv_tile=0.4)
        beveled_box(f"bunk_bed_1_{level}_fascia_foot", (by, FASCIA_T, fascia_h_bunk),
                    (cx, cy - bx / 2 + FASCIA_T / 2, fascia_cz),
                    mats["wood_maple"], "Furniture", props, uv_tile=0.4)
        for sx in (-1, 1):
            beveled_box(f"bunk_bed_1_{level}_fascia_side_{sx}", (FASCIA_T, bx, fascia_h_bunk),
                        (cx + sx * (by / 2 - FASCIA_T / 2), cy, fascia_cz),
                        mats["wood_maple"], "Furniture", props, uv_tile=0.4)
        # platform boards PLATFORM_DROP below the fascia top (zc), so the
        # seated mattress half-hides behind the fascia band (audit F2)
        plat_t = 0.05
        plat_top = zc - PLATFORM_DROP
        beveled_box(f"bunk_bed_1_{level}_platform", (by, bx, plat_t),
                    (cx, cy, plat_top - plat_t / 2),
                    mats["laminate_light"], "Furniture", props, uv_tile=0.6)
        # mattress seated on the platform boards (pillows/duvet added later as
        # decor); duvet X extents clamped to the posts' inner faces (audit F7)
        # mattress inset INSIDE the fascia boards (see the loft note)
        _mattress(f"bunk_bed_1_{level}", "bunk_bed", cx, cy, plat_top,
                  by - 2 * FASCIA_T - 2 * e, bx - 2 * FASCIA_T - 2 * e, mats, props,
                  pillow_toward=+1.0,
                  dress_x_limits=(cx - (by / 2 - post) + e, cx + (by / 2 - post) - e))
    # guardrail on the top bunk interior side, biased to the HEAD half so
    # the foot end stays open where the side ladder hooks (and the stile
    # tips never meet the rail)
    beveled_box("bunk_bed_1_guardrail", (0.04, bx * 0.55, GUARDRAIL_H),
                (cx - by / 2 + 0.02, cy + bx * 0.15, upper_z + GUARDRAIL_H / 2 + 0.02),
                mats["wood_maple"], "Furniture", props, uv_tile=0.4)
    # Ladder on the room-centre side near the FOOT (entry, -y) end, leaning
    # so its top hooks over the upper bunk's side fascia board.
    # Base stand-off 0.328 (was 0.34): the leaning stile tops previously
    # missed the side-fascia outer face by 0.7 mm in X; the 12 mm pull-in
    # gives them a ~13 mm AABB overlap so the ladder visibly rests on the
    # fascia (audit F1). Base y = foot + 0.40 clears the foot post's y-band.
    ladder_base_x = cx - by / 2 - 0.328
    _ladder("bunk_bed_1_ladder", ladder_base_x, cy - bx / 2 + 0.40, upper_z, mats, props,
            lean_sign=1.0, fascia_h=fascia_h_bunk)


def _twin_bed_layout(room, W, D):
    """Shared double-room bed placement math (used by build_twin_beds,
    build_chairs_and_desks, and build_storage so all three derive the SAME
    bed footprint instead of duplicated magic numbers). Matches the official
    double floorplan: bed HEADS at the window wall (+Y), feet toward the
    entry (-Y), beds flush along the left/right side walls."""
    twin = next((o for o in room["objects"] if o["type"] == "twin_xl_bed"), None)
    if not twin:
        return None
    (tbx, tby, _), _ = object_dimensions(twin, (2.03, 0.99, 0.75))
    # Heads tight to the window wall (official views; the radiator sits
    # centered under the window and never reaches the side-wall beds in X)
    twin_cy = bed_head_at_window_y(D, tbx)
    # Beds sit FLUSH against the side walls (audit F5): the outer frame face
    # lands CONTACT_EPS off the baseboard face. Baseboard face = wall inner
    # face - 0.02 board + eps nudge (build_openings), so the eps terms cancel:
    bed_outer_x = W / 2 - WALL_T / 2 - 0.02
    return {
        "tbx": tbx, "tby": tby, "twin_cy": twin_cy,
        "head_y": twin_cy + tbx / 2.0,                 # +Y end (window wall side)
        "foot_y": twin_cy - tbx / 2.0,                 # -Y end (entry side)
        "left_cx": -bed_outer_x + tby / 2.0,
        "right_cx": bed_outer_x - tby / 2.0,
    }


def build_twin_beds(room, mats, W, D):
    obj = next((o for o in room["objects"] if o["type"] == "twin_xl_bed"), None)
    if not obj:
        return
    (bx, by, bz), status = object_dimensions(obj, (2.03, 0.99, 0.75))
    props = custom_props(room, obj, status)
    count = obj.get("count", 2)
    frame_h = 0.30
    layout = _twin_bed_layout(room, W, D)
    twin_cy = layout["twin_cy"]
    positions = [
        (layout["left_cx"], twin_cy),
        (layout["right_cx"], twin_cy),
    ]
    e = CONTACT_EPS
    for i in range(count):
        cx, cy = positions[i % len(positions)]
        pfx = f"twin_xl_bed_{i+1}"
        # The published double/high-rise analog use an open maple rail frame,
        # not the old solid wood plinth. Keep the solid fallback for unrelated
        # future twin-bed rooms, but expose under-bed clearance in Unit 3.
        if is_standard_double(room):
            side_rail_w = 0.07
            side_rail_h = 0.14
            for side, sx in (("left", -1.0), ("right", 1.0)):
                beveled_box(
                    f"{pfx}_frame_side_{side}",
                    (side_rail_w, bx - 0.10, side_rail_h),
                    (cx + sx * (by / 2 - side_rail_w / 2), cy,
                     frame_h - side_rail_h / 2),
                    mats["wood_maple"], "Furniture", props,
                    bevel_width=0.008, uv_tile=0.5,
                )
            for slat in range(5):
                slat_y = cy - bx * 0.36 + slat * (bx * 0.18)
                beveled_box(
                    f"{pfx}_frame_slat_{slat + 1}",
                    (by - 0.12, 0.055, 0.04),
                    (cx, slat_y, frame_h - 0.02),
                    mats["wood_maple"], "Furniture", props,
                    bevel_width=0.006, uv_tile=0.35,
                )
        else:
            # Lifted CONTACT_EPS off the floor so its bottom face never shares
            # the floor-top plane.
            frame_box_h = frame_h - e
            beveled_box(
                f"{pfx}_frame", (by, bx, frame_box_h),
                (cx, cy, e + frame_box_h / 2),
                mats["wood_maple"], "Furniture", props, uv_tile=0.6,
            )
            leg_h = frame_h * 0.5 - e
        # Generic frames need separate legs. The canonical double's full-height
        # head/foot posts below already serve as its four corner supports.
        if not is_standard_double(room):
            leg = 0.05
            for sx in (-1, 1):
                for sy in (-1, 1):
                    beveled_box(f"{pfx}_leg_{sx}_{sy}", (leg, leg, leg_h),
                                (cx + sx * (by / 2 - leg), cy + sy * (bx / 2 - leg), e + leg_h / 2),
                                mats["wood_maple"], "Furniture", props, uv_tile=0.3)
        # Double-specific raised maple head/foot frames. The prior low slab had
        # no visible end boards, unlike both the official render and clean
        # high-rise walkthrough. Heights derive from the schema's estimated Z
        # envelope while the sleeping surface remains at the established 0.30 m.
        if is_standard_double(room):
            post = 0.065
            rail_t = 0.055
            rail_depth = 0.06
            head_h = max(frame_h + 0.34, min(bz, 0.86))
            foot_h = max(frame_h + 0.24, min(bz * 0.82, head_h - 0.08))
            head_y = cy + bx / 2 - post / 2
            foot_y = cy - bx / 2 + post / 2
            for end, end_y, end_h in (
                ("head", head_y, head_h),
                ("foot", foot_y, foot_h),
            ):
                for side, sx in (("left", -1.0), ("right", 1.0)):
                    beveled_box(
                        f"{pfx}_{end}_post_{side}", (post, post, end_h - e),
                        (cx + sx * (by / 2 - post / 2), end_y,
                         e + (end_h - e) / 2),
                        mats["wood_maple"], "Furniture", props,
                        bevel_width=0.008, uv_tile=0.35,
                    )
                lower_z = frame_h + (0.16 if end == "head" else 0.12)
                upper_z = end_h - 0.09
                for level, rail_z in (("lower", lower_z), ("upper", upper_z)):
                    beveled_box(
                        f"{pfx}_{end}_rail_{level}",
                        (by - 2 * post, rail_depth, rail_t),
                        (cx, end_y, rail_z), mats["wood_maple"],
                        "Furniture", props, bevel_width=0.008, uv_tile=0.4,
                    )
        # mattress: pillows now at the HEAD end, i.e. window-wall side (+Y)
        # (pillows/duvet added later as decor)
        _mattress(pfx, "twin_xl_bed", cx, cy, frame_h, by, bx, mats, props,
                  pillow_toward=+1.0)


def _dresser(idx, px, py, dims, sign, mats, props, axis="x"):
    """One 3-drawer chest (light wood). `axis`+`sign` set the front direction:
    axis="x" -> front faces +/-X (sign); axis="y" -> front faces +/-Y (sign).
    Kick lifted CONTACT_EPS off the floor; drawer fronts + knobs pushed proud so
    no face shares the carcass plane."""
    dw, dd, dz = dims           # width, depth, height
    e = CONTACT_EPS
    kick = 0.06
    body_z = dz - kick
    # world footprint: depth runs along the front axis, width across it
    if axis == "x":
        foot_sz = (dd, dw, kick)
        body_sz = (dd, dw, body_z)
        half_depth = dd / 2
    else:
        foot_sz = (dw, dd, kick)
        body_sz = (dw, dd, body_z)
        half_depth = dd / 2
    beveled_box(f"dresser_{idx}_kick", foot_sz, (px, py, e + kick / 2),
                mats["wood_maple"], "Furniture", props, uv_tile=0.5)
    beveled_box(f"dresser_{idx}_carcass", body_sz, (px, py, e + kick + body_z / 2),
                mats["wood_maple"], "Furniture", props, uv_tile=0.6)
    gap = 0.015
    drawer_h = (body_z - 4 * gap) / 3
    across = dw - 2 * gap
    for d in range(3):
        fz = e + kick + gap + drawer_h / 2 + d * (drawer_h + gap)
        if axis == "x":
            front = px + sign * (half_depth - 0.005)
            beveled_box(f"dresser_{idx}_drawer_{d+1}_front", (0.02, across, drawer_h),
                        (front, py, fz), mats["laminate_light"], "Furniture", props, uv_tile=0.4)
            knob_loc = (front + sign * (0.015 + e), py, fz)
            knob_rot = (0, math.radians(90), 0)
        else:
            front = py + sign * (half_depth - 0.005)
            beveled_box(f"dresser_{idx}_drawer_{d+1}_front", (across, 0.02, drawer_h),
                        (px, front, fz), mats["laminate_light"], "Furniture", props, uv_tile=0.4)
            knob_loc = (px, front + sign * (0.015 + e), fz)
            knob_rot = (math.radians(90), 0, 0)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.018, depth=0.03,
                                            location=knob_loc, rotation=knob_rot)
        knob = bpy.context.object
        knob.name = f"dresser_{idx}_drawer_{d+1}_knob"
        knob.data.materials.append(mats["metal_brushed"])
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        except Exception:
            bpy.ops.object.shade_smooth()
        link_to_collection(knob, "Furniture")
        _apply_props(knob, props)


def _shelf_column(idx, px, py, w, d, h, mats, props):
    """Legacy open shelf-column fallback for a non-Unit-3 twin-room variant.

    Nodes share the closet_{idx} group prefix so the viewer groups them with
    that fallback closet. The canonical Unit 3 double uses independent side-wall
    bookshelf groups instead.
    """
    e = CONTACT_EPS
    t = 0.02
    beveled_box(f"closet_{idx}_shelfcol_side_-1", (t, d, h),
                (px - w / 2 + t / 2, py, e + h / 2),
                mats["paint_wall"], "BuiltIns", props, uv_tile=0.5)
    beveled_box(f"closet_{idx}_shelfcol_side_1", (t, d, h),
                (px + w / 2 - t / 2, py, e + h / 2),
                mats["paint_wall"], "BuiltIns", props, uv_tile=0.5)
    beveled_box(f"closet_{idx}_shelfcol_back", (w - 2 * t, t, h),
                (px, py + d / 2 - t / 2, e + h / 2),
                mats["paint_wall"], "BuiltIns", props, uv_tile=0.5)
    n_shelf = 4
    for s in range(n_shelf + 1):
        z = e + 0.03 + s * ((h - 0.06) / n_shelf)
        # boards shrink CONTACT_EPS off the cheeks/back so no face plane is shared
        beveled_box(f"closet_{idx}_shelfcol_shelf_{s + 1}",
                    (w - 2 * t - 2 * e, d - t - 0.01 - e, t),
                    (px, py - t / 2 - e / 2, z + t / 2),
                    mats["laminate_light"], "BuiltIns", props, uv_tile=0.5)


def _build_open_double_closet(
    idx, px, py, cx, cy, cz, mats, props, mirror_props, light_props
):
    """Open built-in double-room alcove with drawers, mirror and globe light.

    The official double references show symmetrical white recessed storage,
    not a pair of closed freestanding wardrobes plus an unmatched shelf tower.
    Mirror/light fixtures live on each alcove's door-facing inner cheek so they
    remain visibly associated with that student's closet without occupying the
    hanging bay.
    """
    e = CONTACT_EPS
    t = 0.04
    kick_h = 0.06
    inner_w = cx - 2 * t
    front_y = py + cy / 2
    back_y = py - cy / 2 + t / 2

    beveled_box(
        f"closet_{idx}_kick", (cx, cy, kick_h),
        (px, py, e + kick_h / 2), mats["paint_wall"],
        "BuiltIns", props, uv_tile=0.5,
    )
    beveled_box(
        f"closet_{idx}_alcove_back", (inner_w, t, cz - kick_h),
        (px, back_y, e + kick_h + (cz - kick_h) / 2),
        mats["paint_wall"], "BuiltIns", props, uv_tile=0.6,
    )
    for tag, sx in (("left", -1.0), ("right", 1.0)):
        beveled_box(
            f"closet_{idx}_alcove_{tag}", (t, cy, cz - kick_h),
            (px + sx * (cx / 2 - t / 2), py,
             e + kick_h + (cz - kick_h) / 2),
            mats["paint_wall"], "BuiltIns", props, uv_tile=0.6,
        )
    beveled_box(
        f"closet_{idx}_alcove_top", (inner_w, cy, t),
        (px, py, e + cz - t / 2), mats["paint_wall"],
        "BuiltIns", props, uv_tile=0.5,
    )

    # Integrated three-drawer bank at the bottom of the open bay.
    drawer_h_total = min(0.72, cz * 0.37)
    drawer_w = inner_w - 0.07
    drawer_d = cy - 0.10
    beveled_box(
        f"closet_{idx}_drawer_carcass", (drawer_w, drawer_d, drawer_h_total),
        (px, py + 0.02, e + kick_h + drawer_h_total / 2),
        mats["wood_maple"], "BuiltIns", props, uv_tile=0.55,
    )
    gap = 0.014
    drawer_h = (drawer_h_total - 4 * gap) / 3
    for d in range(3):
        z = e + kick_h + gap + drawer_h / 2 + d * (drawer_h + gap)
        beveled_box(
            f"closet_{idx}_drawer_{d + 1}_front",
            (drawer_w - 0.03, 0.025, drawer_h - 0.01),
            (px, front_y - 0.018, z), mats["laminate_light"],
            "BuiltIns", props, uv_tile=0.4,
        )
        beveled_box(
            f"closet_{idx}_drawer_{d + 1}_handle",
            (drawer_w * 0.42, 0.025, 0.016),
            (px, front_y + 0.002 + e, z), mats["metal_brushed"],
            "BuiltIns", props, uv_tile=0.2,
        )

    # Upper shelf + hanging rod preserve a visibly usable open closet.
    shelf_z = min(cz - 0.25, 1.72)
    beveled_box(
        f"closet_{idx}_upper_shelf", (inner_w - 0.03, cy - 0.08, 0.025),
        (px, py, shelf_z), mats["laminate_light"],
        "BuiltIns", props, uv_tile=0.45,
    )
    _cyl(
        f"closet_{idx}_hanging_rod", 0.014, inner_w - 0.10,
        (px, py + cy * 0.18, shelf_z - 0.16), mats["metal_brushed"],
        props, rot=(0, math.radians(90), 0), verts=14,
        collection="BuiltIns",
    )

    # Mirror + globe fixture on the alcove's OUTER cheek, facing into the bay.
    # The inner cheek borders the door/appliance slot; mounting there caused
    # the left fixture to intersect the representative Microchill. Both mirrors
    # remain vertical and associated with their own open closet.
    outer_sign = -1.0 if px < 0 else 1.0
    cheek_x = px + outer_sign * (cx / 2 - t - 0.008)
    mirror_y = py + cy * 0.12
    mirror_h = 0.62
    mirror_w = min(0.34, cy * 0.62)
    mirror_z = 1.30
    frame = beveled_box(
        f"closet_{idx}_mirror_frame", (0.018, mirror_w, mirror_h),
        (cheek_x, mirror_y, mirror_z), mats["paint_wall"],
        "BuiltIns", mirror_props, bevel_width=0.006, uv_tile=0.3,
    )
    face = beveled_box(
        f"closet_{idx}_mirror_face", (0.008, mirror_w - 0.05, mirror_h - 0.05),
        (cheek_x - outer_sign * (0.013 + e), mirror_y, mirror_z),
        mats["metal_brushed"], "BuiltIns", mirror_props,
        bevel_width=0.003, uv_tile=0.2,
    )
    # Parent association is expressed spatially + by the shared closet_N
    # prefix; keeping the meshes top-level preserves viewer grouping behavior.
    _ = (frame, face)
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=20, ring_count=12, radius=0.085,
        location=(cheek_x - outer_sign * 0.035, mirror_y, 1.86),
    )
    globe = bpy.context.object
    globe.name = f"closet_{idx}_globe_light"
    globe.data.materials.append(mats["paint_wall"])
    try:
        bpy.ops.object.shade_smooth()
    except Exception:
        pass
    link_to_collection(globe, "BuiltIns")
    _apply_props(globe, light_props)


def _build_one_closet(idx, px, py, cx, cy, cz, mats, props):
    """One closet carcass + two doors + handles at (px, py). Shared by both the
    symmetric flank-the-entry placement and the single-side fallback."""
    e = CONTACT_EPS
    kick = 0.06
    body_z = cz - kick
    # WHITE built-in finish per the official 3D views (the closet modules
    # read as recessed white built-ins, not freestanding wood wardrobes) —
    # this also keeps the storage wall from visually crowding the room.
    beveled_box(f"closet_{idx}_kick", (cx, cy, kick), (px, py, e + kick / 2),
                mats["paint_wall"], "BuiltIns", props, uv_tile=0.5)
    beveled_box(f"closet_{idx}_carcass", (cx, cy, body_z),
                (px, py, e + kick + body_z / 2), mats["paint_wall"],
                "BuiltIns", props, uv_tile=0.7)
    seam = 0.02
    door_w = (cx - 3 * seam) / 2
    door_y = py + cy / 2 + e
    for sx in (-1, 1):
        dxc = px + sx * (door_w / 2 + seam / 2)
        beveled_box(f"closet_{idx}_door_{sx}", (door_w, 0.03, body_z - 0.06),
                    (dxc, door_y, e + kick + body_z / 2),
                    mats["paint_wall"], "BuiltIns", props, uv_tile=0.6)
        beveled_box(f"closet_{idx}_handle_{sx}", (0.02, 0.03, 0.20),
                    (px - sx * seam - sx * 0.02, door_y + 0.015 + e,
                     e + kick + body_z / 2),
                    mats["metal_brushed"], "BuiltIns", props, uv_tile=0.2)


def build_storage(room, mats, W, D):
    e = CONTACT_EPS
    has_loft = any(o["type"] == "loft_bed" for o in room["objects"])
    # ---- Closets flank the ENTRY in the canonical double. Other room types
    # may place the door off-centre, so compute both gaps from the schema-driven
    # door position and retain the existing honest fallback when a future room
    # cannot fit two usable modules. ----
    # Rightmost X and farthest Y (depth off the entry wall) reached by any
    # closet, so later furniture (microchill) can derive its own clearance
    # instead of assuming a fixed closet footprint.
    closets_right_edge = None
    closets_far_y = None
    micro_slot = None
    closet = next((o for o in room["objects"] if o["type"] == "closet"), None)
    if closet:
        (cx, cy, cz), status = object_dimensions(closet, (0.9, 0.6, 2.1))
        props = custom_props(room, closet, status)
        mirror_obj = next((o for o in room["objects"] if o.get("id") == "mirror_group"), None)
        light_obj = next(
            (o for o in room["objects"] if o.get("id") == "closet_light_group"), None
        )
        mirror_props = custom_props(
            room, mirror_obj, (mirror_obj or {}).get("dimension_status", "unknown")
        )
        mirror_props["notes"] = (
            "Mirror existence/count are official; rendered size and mounting "
            "are illustrative because exact dimensions are unknown."
        )
        light_props = custom_props(
            room, light_obj, (light_obj or {}).get("dimension_status", "unknown")
        )
        light_props["notes"] = (
            "Closet-area light existence/count are official; fixture geometry "
            "and mounting are illustrative because exact dimensions are unknown."
        )
        count = closet.get("count", 1)
        door_obj = next((o for o in room["objects"] if o["type"] == "door"), None)
        (door_w_sch, _, _), _ = object_dimensions(door_obj or {}, (0.91, 0.04, 2.05))
        door_cx = door_center_x(room, W)
        door_half = door_w_sch / 2 + 0.05 + 0.01   # casing half-width + reveal
        left_gap = (door_cx - door_half) - (-W / 2 + WALL_T)
        right_gap = (W / 2 - WALL_T) - (door_cx + door_half)
        min_closet_w = 0.5   # below this a "closet" reads as an implausible sliver
        py = -D / 2 + WALL_T / 2 + cy / 2 + 0.02 + e   # back at the baseboard face
        closets_far_y = py + cy / 2       # closet depth off the entry wall (same for both branches)
        micro = next((o for o in room["objects"] if o["type"] == "microchill"), None)
        (mi_w, _, _), _ = object_dimensions(micro or {}, (0.48, 0.50, 0.86))
        shelf_w = 0.30                    # legacy non-canonical fallback column
        if count >= 2 and left_gap >= min_closet_w and right_gap >= cx:
            if is_standard_double(room):
                # Canonical double: two equal, OPEN alcoves mirror each other
                # across the centered door. The old right-only shelf column was
                # an unsupported duplicate of the bookshelf already modeled
                # over each side-wall dresser.
                available_left = left_gap - (mi_w + 0.06 if micro else 0.04)
                available_right = right_gap - 0.04
                closet_w = min(cx, available_left, available_right)
                left_px = (-W / 2 + WALL_T) + closet_w / 2 + 0.02
                right_px = (W / 2 - WALL_T) - closet_w / 2 - 0.02
                _build_open_double_closet(
                    1, left_px, py, closet_w, cy, cz, mats, props,
                    mirror_props, light_props,
                )
                _build_open_double_closet(
                    2, right_px, py, closet_w, cy, cz, mats, props,
                    mirror_props, light_props,
                )
                closets_right_edge = right_px + closet_w / 2
                micro_slot = (left_px + closet_w / 2 + 0.02 + mi_w / 2, py)
                for i in range(2, count):
                    px = right_px - closet_w / 2 - 0.08 - (i - 2) * (cx + 0.04) - cx / 2
                    _build_open_double_closet(
                        i + 1, px, py, cx, cy, cz, mats, props,
                        mirror_props, light_props,
                    )
            else:
                # Preserve the earlier symmetric closed-storage fallback for
                # any future non-standard twin-bed room using this branch.
                left_w = min(cx, left_gap - (mi_w + 0.06 if micro else 0.04))
                right_w = min(cx, right_gap - shelf_w - 0.06)
                left_px = (-W / 2 + WALL_T) + left_w / 2 + 0.02
                right_px = (W / 2 - WALL_T) - right_w / 2 - 0.02
                _build_one_closet(1, left_px, py, left_w, cy, cz, mats, props)
                _build_one_closet(2, right_px, py, right_w, cy, cz, mats, props)
                _shelf_column(2, right_px - right_w / 2 - 0.02 - shelf_w / 2,
                              py, shelf_w, cy, cz, mats, props)
                closets_right_edge = right_px + right_w / 2
                micro_slot = (left_px + left_w / 2 + 0.02 + mi_w / 2, py)
                for i in range(2, count):
                    px = right_px - right_w / 2 - shelf_w - 0.08 - (i - 2) * (cx + 0.04) - cx / 2
                    _build_one_closet(i + 1, px, py, cx, cy, cz, mats, props)
        else:
            # TRIPLE (door hugs the left corner): both closets stack along
            # the entry wall right of the door — "two closets built into the
            # interior wall to the right of the door". dresser_1 takes the
            # wall run right of them (see the dresser pass; its drawers then
            # open into the room), and the Microchill moves to the right
            # wall's entry band, so no shelf column here — the triple's
            # bookshelves are the under-loft hutches (official room photo).
            door_right = door_cx + door_half + 0.02
            px1 = door_right + cx / 2
            _build_one_closet(1, px1, py, cx, cy, cz, mats, props)
            run = px1 + cx / 2
            if count >= 2:
                px2 = run + 0.02 + cx / 2
                _build_one_closet(2, px2, py, cx, cy, cz, mats, props)
                run = px2 + cx / 2
                for i in range(2, count):
                    px = run + 0.04 + cx / 2 + (i - 2) * (cx + 0.04)
                    _build_one_closet(i + 1, px, py, cx, cy, cz, mats, props)
                    run = px + cx / 2
            closets_right_edge = run

    # ---- Dressers ----
    dresser = next((o for o in room["objects"] if o["type"] == "dresser"), None)
    bookshelf = next((o for o in room["objects"] if o.get("id") == "bookshelf_group"), None)
    bookshelf_props = None
    if bookshelf:
        bookshelf_props = custom_props(
            room, bookshelf, bookshelf.get("dimension_status", "unknown")
        )
        bookshelf_props["notes"] = (
            "Representative wall-mounted bookshelf placement; exact dimensions "
            "and offsets are not published."
        )
    if dresser:
        dims, status = object_dimensions(dresser, (0.76, 0.51, 0.76))
        dw, dd, dz = dims
        props = custom_props(room, dresser, status)
        count = dresser.get("count", 1)
        if has_loft:
            # Triple: dresser_1 stands along the ENTRY wall right of the
            # closet run, drawers opening into the room (near the bunk's
            # foot corner — "a dresser is at the foot of the bunk bed").
            # dresser_2 sits in the LOFT-FOOT corner against the left wall,
            # drawers facing the room — the spot the official view shows;
            # the enlarged shell (and the loft ladder moving to the bed's
            # side) makes it clear of the 0.9 m door swing, which the
            # generator still clamps for explicitly.
            loft = next((o for o in room["objects"] if o["type"] == "loft_bed"), None)
            (lbx2, _, _), _ = object_dimensions(loft or {}, (2.03, 0.99, 1.75))
            loft_foot_y = bed_head_at_window_y(D, lbx2) - lbx2 / 2
            px = ((closets_right_edge + 0.04 + dw / 2)
                  if closets_right_edge is not None else W / 2 - WALL_T - dw / 2 - 0.04)
            y1 = -D / 2 + WALL_T / 2 + 0.02 + CONTACT_EPS + dd / 2
            px2 = -(W / 2 - WALL_T / 2 - 0.02 - CONTACT_EPS - dd / 2)
            py2 = loft_foot_y - 0.01 - dw / 2
            py2 = max(py2, -(D / 2 - WALL_T / 2) + DOOR_SWING_CLEAR + dw / 2 + 0.01)
            slots = [
                (px, y1, +1, "y"),
                (px2, py2, +1, "x"),
            ]
        else:
            # Double representative: the published view suggests low storage
            # in the side-wall bands between the bed feet and entry closets,
            # but Berkeley does not publish exact dresser footprints or
            # offsets. Keep this as a 3D visualization choice; the canonical
            # 2D plan deliberately omits these unverified placements.
            layout = _twin_bed_layout(room, W, D)
            foot_y = layout["foot_y"]                    # entry-side end of the beds
            dresser_y = foot_y - 0.02 - dd / 2           # just past the bed foot
            px_wall = W / 2 - WALL_T / 2 - 0.02 - CONTACT_EPS - dw / 2
            slots = [
                (-px_wall, dresser_y, +1, "y"),
                (px_wall, dresser_y, +1, "y"),
                (-px_wall, dresser_y, +1, "y"),
                (px_wall, dresser_y, +1, "y"),
            ]
        for i in range(count):
            px, py, sign, ax = slots[i % len(slots)]
            _dresser(i + 1, px, py, dims, sign, mats, props, axis=ax)
            # record wall-backed dressers — the decor pass mounts a vanity
            # mirror + light on the wall above them
            if abs(abs(px) + dw / 2 - (W / 2 - WALL_T / 2 - 0.02)) < 0.05:
                _DRESSERS.append({"px": px, "py": py, "top": dz,
                                  "wall": "right" if px > 0 else "left"})
            elif abs(py - dd / 2 - (-D / 2 + WALL_T / 2 + 0.02)) < 0.05:
                _DRESSERS.append({"px": px, "py": py, "top": dz,
                                  "wall": "entry"})
            if not has_loft and bookshelf_props:
                # Wall bookshelf above each double dresser ("each side wall
                # has one bookshelf and one extra-long twin bed"): two boards
                # + side cheeks on the wall over the dresser vanity spot,
                # width capped to the free band between closet and bed foot.
                sh_d = 0.20
                band_lo = (closets_far_y + 0.02 if closets_far_y is not None
                           else py - dd / 2)
                band_hi = py + dd / 2
                sh_w = band_hi - band_lo
                sh_y = (band_lo + band_hi) / 2
                sh_x = (px / abs(px)) * (W / 2 - WALL_T / 2 - 0.02 - CONTACT_EPS - sh_d / 2)
                for b, z in ((1, 1.15), (2, 1.55)):
                    beveled_box(f"bookshelf_{i + 1}_board_{b}", (sh_d, sh_w, 0.02),
                                (sh_x, sh_y, z + 0.01),
                                mats["wood_maple"], "Furniture", bookshelf_props, uv_tile=0.4)
                for s in (-1, 1):
                    beveled_box(f"bookshelf_{i + 1}_side_{s}", (sh_d, 0.02, 0.44),
                                (sh_x, sh_y + s * (sh_w / 2 - 0.01), 1.15 + 0.22),
                                mats["wood_maple"], "Furniture", bookshelf_props, uv_tile=0.4)

    # ---- Microchill (fridge/microwave combo) ----
    micro = next((o for o in room["objects"] if o["type"] == "microchill"), None)
    if micro:
        (mx, my, mz), status = object_dimensions(micro, (0.48, 0.50, 0.86))
        props = custom_props(room, micro, status)
        # DOUBLE: the Microchill stands along the ENTRY wall in the slot the
        # closet pass reserved (between the left closet and the door casing
        # — fridge by the door). TRIPLE: the entry wall is full (closets +
        # dresser_1), so it takes the RIGHT wall's entry band between the
        # closet front and the bunk's foot, door facing -x into the room.
        # Representative placements, see ledger.
        if micro_slot is not None:
            px, py = micro_slot
            py = -D / 2 + WALL_T / 2 + 0.02 + CONTACT_EPS + my / 2
            axis, front_sign = "y", +1
        elif has_loft:
            px = W / 2 - WALL_T / 2 - 0.02 - CONTACT_EPS - my / 2
            py = ((closets_far_y + 0.04 + mx / 2)
                  if closets_far_y is not None else -D / 2 + 0.75)
            axis, front_sign = "x", -1
        else:
            # no closets in the schema: fall back to the entry wall's right
            # corner, front facing +y
            px = W / 2 - WALL_T - mx / 2 - 0.04
            py = -D / 2 + WALL_T / 2 + 0.02 + CONTACT_EPS + my / 2
            axis, front_sign = "y", +1
        # body (lifted CONTACT_EPS off the floor). axis="x": depth (my) runs
        # along X against the wall, width (mx) runs along Y.
        if axis == "y":
            body_sz = (mx, my, mz)
        else:
            body_sz = (my, mx, mz)
        beveled_box("microchill_1_body", body_sz, (px, py, e + mz / 2),
                    mats["metal_brushed"], "Furniture", props, uv_tile=0.5)
        if is_standard_double(room):
            # A Microchill is a combination refrigerator + microwave, not one
            # featureless tall refrigerator. Preserve the established body,
            # door and handle names for grouping while splitting the facade
            # into an unmistakable lower fridge and upper microwave.
            fridge_h = mz * 0.62
            unit_gap = 0.035
            microwave_h = mz - fridge_h - unit_gap - 0.04
            fridge_z = e + 0.025 + (fridge_h - 0.05) / 2
            microwave_z = e + fridge_h + unit_gap + microwave_h / 2
            if axis == "y":
                front_y = py + front_sign * (my / 2 + e)
                door_sz = (mx - 0.06, 0.025, fridge_h - 0.05)
                door_loc = (px, front_y, fridge_z)
                handle_loc = (
                    px - mx / 2 + 0.065,
                    py + front_sign * (my / 2 + 0.025 + e),
                    fridge_z,
                )
                separator_sz = (mx - 0.035, 0.035, 0.025)
                separator_loc = (px, front_y, e + fridge_h + unit_gap / 2)
                micro_face_sz = (mx - 0.045, 0.032, microwave_h)
                micro_face_loc = (px, front_y + front_sign * 0.006, microwave_z)
                window_sz = (mx * 0.56, 0.014, microwave_h * 0.52)
                window_loc = (
                    px - mx * 0.075,
                    front_y + front_sign * 0.025,
                    microwave_z + microwave_h * 0.03,
                )
                control_sz = (mx * 0.14, 0.014, microwave_h * 0.58)
                control_loc = (
                    px + mx * 0.34,
                    front_y + front_sign * 0.025,
                    microwave_z + microwave_h * 0.02,
                )
                micro_handle_sz = (mx * 0.56, 0.024, 0.022)
                micro_handle_loc = (
                    px - mx * 0.075,
                    front_y + front_sign * 0.038,
                    microwave_z - microwave_h * 0.34,
                )
            else:
                front_x = px + front_sign * (my / 2 + e)
                door_sz = (0.025, mx - 0.06, fridge_h - 0.05)
                door_loc = (front_x, py, fridge_z)
                handle_loc = (
                    px + front_sign * (my / 2 + 0.025 + e),
                    py - mx / 2 + 0.065,
                    fridge_z,
                )
                separator_sz = (0.035, mx - 0.035, 0.025)
                separator_loc = (front_x, py, e + fridge_h + unit_gap / 2)
                micro_face_sz = (0.032, mx - 0.045, microwave_h)
                micro_face_loc = (front_x + front_sign * 0.006, py, microwave_z)
                window_sz = (0.014, mx * 0.56, microwave_h * 0.52)
                window_loc = (
                    front_x + front_sign * 0.025,
                    py - mx * 0.075,
                    microwave_z + microwave_h * 0.03,
                )
                control_sz = (0.014, mx * 0.14, microwave_h * 0.58)
                control_loc = (
                    front_x + front_sign * 0.025,
                    py + mx * 0.34,
                    microwave_z + microwave_h * 0.02,
                )
                micro_handle_sz = (0.024, mx * 0.56, 0.022)
                micro_handle_loc = (
                    front_x + front_sign * 0.038,
                    py - mx * 0.075,
                    microwave_z - microwave_h * 0.34,
                )
            beveled_box("microchill_1_door", door_sz, door_loc,
                        mats["metal_brushed"], "Furniture", props, uv_tile=0.4)
            beveled_box("microchill_1_handle", (0.03, 0.03, fridge_h * 0.42),
                        handle_loc, mats["metal_dark"], "Furniture", props, uv_tile=0.2)
            beveled_box("microchill_1_separator", separator_sz, separator_loc,
                        mats["metal_dark"], "Furniture", props, uv_tile=0.2)
            beveled_box("microchill_1_microwave_face", micro_face_sz, micro_face_loc,
                        mats["metal_brushed"], "Furniture", props, uv_tile=0.35)
            beveled_box("microchill_1_microwave_window", window_sz, window_loc,
                        mats["metal_dark"], "Furniture", props, uv_tile=0.25)
            beveled_box("microchill_1_microwave_control", control_sz, control_loc,
                        mats["metal_dark"], "Furniture", props, uv_tile=0.2)
            beveled_box("microchill_1_microwave_handle", micro_handle_sz,
                        micro_handle_loc, mats["metal_dark"], "Furniture", props,
                        uv_tile=0.2)
        else:
            if axis == "y":
                door_sz = (mx - 0.06, 0.02, mz - 0.10)
                door_loc = (px, py + front_sign * (my / 2 + e), e + mz / 2)
                handle_loc = (px - mx / 2 + 0.06, py + front_sign * (my / 2 + 0.02 + e), e + mz / 2)
            else:
                door_sz = (0.02, mx - 0.06, mz - 0.10)
                door_loc = (px + front_sign * (my / 2 + e), py, e + mz / 2)
                handle_loc = (px + front_sign * (my / 2 + 0.02 + e), py - mx / 2 + 0.06, e + mz / 2)
            beveled_box("microchill_1_door", door_sz, door_loc, mats["metal_brushed"],
                        "Furniture", props, uv_tile=0.4)
            beveled_box("microchill_1_handle", (0.03, 0.03, mz * 0.4), handle_loc,
                        mats["metal_brushed"], "Furniture", props, uv_tile=0.2)
            # Existing triple top vent slots.
            for s in range(3):
                if axis == "y":
                    vent_sz = (mx * 0.6, 0.01, 0.015)
                    vent_loc = (px, py + front_sign * (-my / 2 + 0.10 + s * 0.04), e + mz - 0.03)
                else:
                    vent_sz = (0.01, mx * 0.6, 0.015)
                    vent_loc = (px + front_sign * (-my / 2 + 0.10 + s * 0.04), py, e + mz - 0.03)
                beveled_box(f"microchill_1_vent_{s+1}", vent_sz, vent_loc,
                            mats["metal_brushed"], "Furniture", props, uv_tile=0.2)


# --------------------------------------------------------------------------
# Lived-in staging (M1 decor). Generator-side config only — the room JSON is
# untouched. Every mesh name starts with `decor_`; every mesh carries the 9
# standard keys plus `decorative:"true"` and a `notes` caveat. Bed dressing and
# desk items also carry `attached_to` (furniture GROUP prefix). Placement always
# derives from the recorded furniture/opening descriptors, never magic numbers.
# --------------------------------------------------------------------------

def _cyl(name, radius, depth, loc, mat, props, rot=None, verts=20,
        collection="Decor"):
    """Small textured cylinder with metadata baked on. Used for lamp/mug/rod and
    the task-chair casters/gas-lift. `collection` selects the target group."""
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc,
                                        vertices=verts,
                                        rotation=rot or (0.0, 0.0, 0.0))
    obj = bpy.context.object
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
    except Exception:
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            pass
    link_to_collection(obj, collection)
    _apply_props(obj, props)
    return obj


def _cone(name, radius_bottom, radius_top, depth, loc, mat, props, verts=20):
    """Truncated cone (lamp shade). Base metadata baked on."""
    bpy.ops.mesh.primitive_cone_add(radius1=radius_bottom, radius2=radius_top,
                                    depth=depth, location=loc, vertices=verts)
    obj = bpy.context.object
    obj.name = name
    if mat:
        obj.data.materials.append(mat)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
    except Exception:
        try:
            bpy.ops.object.shade_smooth()
        except Exception:
            pass
    link_to_collection(obj, "Decor")
    _apply_props(obj, props)
    return obj


def build_bed_dressing(room, mats):
    """Fitted duvet slab + a second pillow on each recorded sleeping surface,
    and the RENAMED baseline pillow. Bed dressing is decor: hiding decor bares
    the mattress. Every mesh gets attached_to = the bed's furniture group."""
    for surf in _SLEEP_SURFACES:
        sid = surf["surface_id"]          # e.g. loft_bed_1, bunk_bed_1_upper
        group = surf["group"]             # loft_bed | bunk_bed | twin_xl_bed
        cx, cy = surf["cx"], surf["cy"]
        top = surf["top"]                 # mattress top surface (world Z)
        m_x = surf["ext_x"]               # mattress extent along X (bed WIDTH)
        m_y = surf["ext_y"]               # mattress extent along Y (bed LENGTH)
        head = surf["head_toward"]        # +/-1 : y-direction of the head end
        props = decor_props(room, attached_to=group)

        # Head/foot run along Y for every bed type (pillow_toward is a y sign).
        # ---- Fitted duvet: covers the foot ~2/3 of the mattress LENGTH (Y),
        # overhang past the mattress WIDTH (X) each side, generous bevel so it
        # reads soft. A thin ridge at its head edge models the fold seam.
        # loft_bed/bunk_bed now have a deep flat fascia board around the
        # platform edge (see build_loft_bed/build_bunk_bed); give those beds a
        # bigger overhang so the duvet visibly drapes down over the fascia lip
        # rather than stopping flush at the mattress edge like the plain twins. ----
        overhang = 0.035 if group in ("loft_bed", "bunk_bed") else 0.025
        duvet_w = m_x + 2 * overhang              # slight side overhang (X)
        duvet_cx = cx
        # Posted beds (loft/bunk): the full-height corner posts rise through
        # the duvet's Z band, so clamp its X extents to the posts' inner faces
        # (recorded by the bed builder) — a draped duvet must never slice
        # through a post (audit F7). This also keeps it off the leaning
        # ladder's AABB.
        lim = surf.get("dress_x_limits")
        if lim:
            lo = max(cx - duvet_w / 2.0, lim[0])
            hi = min(cx + duvet_w / 2.0, lim[1])
            duvet_cx = (lo + hi) / 2.0
            duvet_w = hi - lo
        duvet_len = m_y * (2.0 / 3.0)             # foot two-thirds (Y)
        duvet_t = 0.05
        # duvet centred over the FOOT portion: shift away from the head end.
        # Lifted CONTACT_EPS so its bottom never shares the mattress-top plane.
        foot_center_y = cy - head * (m_y / 2.0 - duvet_len / 2.0)
        duvet_z = top + CONTACT_EPS + duvet_t / 2.0
        beveled_box(f"decor_duvet_{sid}", (duvet_w, duvet_len, duvet_t),
                    (duvet_cx, foot_center_y, duvet_z), mats["fabric_heather"],
                    "Decor", props, bevel_width=0.04, uv_tile=0.5)
        # fold seam: a thin raised ridge at the duvet's head edge (a second,
        # slightly-offset stacked slab), reading as the turned-down top hem.
        # Lifted another CONTACT_EPS above the duvet top so no shared plane.
        fold_len = 0.10
        fold_t = 0.035
        fold_y = foot_center_y + head * (duvet_len / 2.0 - fold_len / 2.0)
        fold_z = top + CONTACT_EPS + duvet_t + CONTACT_EPS + fold_t / 2.0
        beveled_box(f"decor_duvet_{sid}_fold", (duvet_w, fold_len, fold_t),
                    (duvet_cx, fold_y, fold_z), mats["fabric_heather"],
                    "Decor", props, bevel_width=0.04, uv_tile=0.5)

        # ---- Two pillows at the head end (the first replaces the old baseline
        # furniture pillow; renamed into the decor group). ----
        pillow_depth = min(m_y * 0.28, 0.42)      # pillow depth along Y
        ph = 0.09
        pillow_w = m_x * 0.44                      # pillow width along X
        pillow_y = cy + head * (m_y / 2.0 - pillow_depth / 2.0 - 0.04)
        pillow_z = top + CONTACT_EPS + ph / 2.0
        # The canonical double references show one standard pillow per Twin XL;
        # other room branches retain the fuller two-pillow illustrative staging.
        px_off = min(pillow_w * 0.55, (m_x - pillow_w) / 2.0)
        pillow_specs = (("a", 0.0),) if is_standard_double(room) else (("a", -1.0), ("b", 1.0))
        for tag, sx in pillow_specs:
            beveled_box(f"decor_pillow_{sid}_{tag}",
                        (pillow_w, pillow_depth, ph),
                        (cx + sx * px_off, pillow_y, pillow_z),
                        mats["paint_wall"], "Decor", props,
                        bevel_width=0.03, uv_tile=0.4)


def build_area_rug(room, mats, W, D):
    """Thin woven rug in the OPEN floor between the beds. With every bed
    head at the window and the desks toward the window line, the free floor
    is the band between the window-side furniture (recorded as
    _OPEN_FLOOR_Y_HI by the desk pass) and the entry door's swing zone.
    X clamps to the gap between the innermost bed edges."""
    # The canonical double reference already has wall-to-wall dark carpet and
    # leaves no verified free rug band around the tandem desk run. Omitting an
    # illustrative mat also prevents the generic degenerate-band fallback from
    # moving a raised slab underneath desk/chair feet.
    if is_standard_double(room) or not _SLEEP_SURFACES:
        return
    props = decor_props(room)  # freestanding: no attached_to
    # Distinct bed X centres (loft/bunk are single; twins are two).
    xs = sorted({round(s["cx"], 4) for s in _SLEEP_SURFACES})
    center_x = sum(xs) / len(xs)
    if len(xs) >= 2:
        # innermost mattress edges of the left/right side beds
        left = max(s["cx"] + s["ext_x"] / 2 for s in _SLEEP_SURFACES if s["cx"] <= center_x)
        right = min(s["cx"] - s["ext_x"] / 2 for s in _SLEEP_SURFACES if s["cx"] >= center_x)
        gap = right - left
    else:
        gap = W - 1.0
    rug_w = min(1.20, max(0.6, gap - 0.20))
    # Y band: entry swing zone -> window-side furniture line.
    y_lo = -(D / 2 - WALL_T / 2) + DOOR_SWING_CLEAR + 0.05
    y_hi = (_OPEN_FLOOR_Y_HI if _OPEN_FLOOR_Y_HI is not None else D / 2 - 1.0)
    if y_hi - y_lo < 0.5:      # degenerate band: fall back to a small centre mat
        y_lo, y_hi = -0.45, 0.45
    rug_d = min(1.80, y_hi - y_lo)
    center_y = (y_lo + y_hi) / 2.0
    rug_t = RUG_T
    # Lifted 2*CONTACT_EPS so the rug bottom sits above BOTH the floor (z=0) and
    # any floor-resting feet lifted by 1*CONTACT_EPS (bed ladders, desk sides),
    # so no shared face plane where the rug tucks under a ladder foot.
    beveled_box("decor_rug_1", (rug_w, rug_d, rug_t),
                (center_x, center_y, 2 * CONTACT_EPS + rug_t / 2.0), mats["rug_woven"],
                "Decor", props, bevel_width=0.008, uv_tile=0.9)


def build_desk_setup(room, mats):
    """Lamp + closed laptop + book stack + mug on desk 1's top surface. All
    heights derive from the recorded desk top_z; nothing is hardcoded. Placement
    is done in the desk's LOCAL frame (u = along-wall, v = depth toward the room
    on the `face` side) and mapped to world, so it lands correctly whether desk 1
    is a window-wall desk (axis="y") or the rotated under-loft desk (axis="x").
    Items stay on the OPEN front half (toward `face`) so a wall-side hutch never
    collides. Every item is lifted CONTACT_EPS above the desktop."""
    if not _DESK1:
        return
    cx = _DESK1["cx"]
    cy = _DESK1["cy"]
    top = _DESK1["top"]
    dw = _DESK1["w"]           # width along the wall (local u span)
    dd = _DESK1["d"]           # depth away from the wall
    face = _DESK1["face"]      # +/-1 : direction (along depth) toward the room
    axis = _DESK1.get("axis", "y")
    hutch = _DESK1.get("hutch", False)
    hutch_depth = _DESK1.get("hutch_depth", 0.0)
    props = decor_props(room, attached_to="desk")
    e = CONTACT_EPS
    z0 = top + e               # every item bottom sits here

    # Usable front depth: if there is a wall-side hutch, keep items on the open
    # portion between the hutch front and the room edge.
    open_depth = dd - hutch_depth
    # local-v centre of the open zone (measured from desk centre, toward `face`)
    open_mid_v = face * (dd / 2.0 - open_depth / 2.0)
    # back-of-open (toward wall) and near (toward room) v offsets. The 0.10
    # back margin (was 0.08) keeps the rotated book stack's AABB fully on
    # desk 1's own top: on the double's butted island the back edge IS the
    # desk_1/desk_2 seam and the stack straddled it by 5 mm (audit F9).
    back_v = open_mid_v - face * (open_depth / 2.0 - 0.10)
    near_v = open_mid_v + face * (open_depth / 2.0 - 0.12)

    def L2W(u, v):
        """Local (along-wall u, depth v) -> world (x, y)."""
        if axis == "y":
            return cx + u, cy + v
        return cx + v, cy + u     # axis == "x": u runs along Y, v along X

    # ---- Lamp at a back corner (along-wall left) ----
    lamp_u = -dw * 0.34
    lamp_x, lamp_y = L2W(lamp_u, back_v)
    base_h = 0.02
    stem_h = 0.28
    shade_h = 0.10
    _cyl("decor_lamp_base", 0.055, base_h, (lamp_x, lamp_y, z0 + base_h / 2.0),
         mats["metal_brushed"], props)
    _cyl("decor_lamp_stem", 0.010, stem_h,
         (lamp_x, lamp_y, z0 + base_h + stem_h / 2.0),
         mats["metal_brushed"], props)
    _cone("decor_lamp_shade", 0.075, 0.045, shade_h,
          (lamp_x, lamp_y, z0 + base_h + stem_h + shade_h / 2.0),
          mats["paint_wall"], props)

    # ---- Closed laptop (thin slab) near the room edge, centred along the wall.
    # Rotate about the vertical so its short axis follows the depth direction. ----
    lap_w = min(0.33, dw * 0.34)
    lap_d = 0.24
    lap_t = 0.018
    lap_x, lap_y = L2W(dw * 0.04, near_v)
    lap_rz = math.radians(90) if axis == "x" else 0.0
    beveled_box("decor_laptop", (lap_w, lap_d, lap_t),
                (lap_x, lap_y, z0 + lap_t / 2.0), mats["metal_brushed"],
                "Decor", props, bevel_width=0.006, rot=(0, 0, lap_rz),
                uv_tile=0.3)

    # ---- Small book stack (3 thin boxes, slightly rotated, varied sizes) ----
    stack_x, stack_y = L2W(dw * 0.34, back_v)
    base_rz = math.radians(90) if axis == "x" else 0.0
    book_specs = [
        (0.20, 0.15, 0.035, math.radians(6), mats["wood_walnut"]),
        (0.185, 0.14, 0.030, math.radians(-4), mats["laminate_light"]),
        (0.17, 0.135, 0.028, math.radians(9), mats["fabric_navy"]),
    ]
    bz = z0
    for idx, (bw, bd, bt, rz, bmat) in enumerate(book_specs, start=1):
        beveled_box(f"decor_book_{idx}", (bw, bd, bt),
                    (stack_x, stack_y, bz + bt / 2.0), bmat, "Decor", props,
                    bevel_width=0.004, rot=(0, 0, base_rz + rz), uv_tile=0.3)
        bz += bt + CONTACT_EPS       # small gap between stacked books

    # ---- Mug (small cylinder) near the front-right of the desk. Given a tiny
    # extra lift so its base does not share the laptop/other-item baseline. ----
    mug_x, mug_y = L2W(dw * 0.20, near_v)
    mug_h = 0.09
    _cyl("decor_mug", 0.038, mug_h, (mug_x, mug_y, z0 + CONTACT_EPS + mug_h / 2.0),
         mats["paint_wall"], props)


def build_curtains(room, mats, W):
    """Rod + end caps + two panels, parented to wall_back_window so they hide
    with that wall in the dollhouse view. Geometry derives from the recorded
    window descriptor. Per the official views/photo the window spans most of
    the wall and BOTH bed heads stand against it, so the panels hang bunched
    just INSIDE each bed's head band (curtains pulled to the sides), never
    into the beds' space."""
    if not _WINDOW:
        return
    props = decor_props(room)   # freestanding staging: no attached_to
    wall = _WINDOW["wall"]
    cx = _WINDOW["cx"]
    wx = _WINDOW["wx"]
    wall_y = _WINDOW["wall_y"]
    win_top = _WINDOW["top"]
    sill = _WINDOW["sill"]

    rod_r = 0.018                          # thicker rod per spec
    rod_z = win_top + 0.14                 # mounted just above the window casing
    rod_len = wx + 0.40                    # spans wider than the window
    wall_inner = wall_y - WALL_T / 2
    # stand-off sized to the END CAPS (radius rod_r*1.7 > the rod's own), so
    # neither the rod nor its caps pierce the wall face
    rod_y = wall_inner - rod_r * 1.7 - 0.005
    panel_t = 0.025
    # Panel rest plane hugs the wall (back face CONTACT_EPS inside the wall's
    # inner face); the drape ripple bulges ONE-SIDED into the room (see
    # _ripple_along_x), so the fold depth budget is bounded on both sides:
    # folds can never reach back into the wall, and their room-ward tips stay
    # clear of furniture backed up near the window line (the triple's third
    # desk backs to within 80 mm of this wall). Audit F10.
    panel_y = wall_inner - CONTACT_EPS - panel_t / 2.0
    # The published double rendering/high-rise analog stop the panels above the
    # paired radiators. Triple gallery references use longer curtains, so retain
    # their existing floor-length treatment only outside the canonical double.
    panel_bottom = sill + 0.02 if is_standard_double(room) else 0.12
    panel_top = rod_z - rod_r - 0.005      # hangs just below the rod
    panel_h = panel_top - panel_bottom
    panel_z = (panel_top + panel_bottom) / 2.0
    panel_w = 0.72                          # generous panel over each outer third
                                            # of the glass (curtains pulled open,
                                            # clearly readable as drapes)
    # Panels stay between the two bed-head bands: find the beds' inner faces
    # (loft/bunk stand 0.10 off their side wall; twins sit at the baseboard).
    bed_inner_x = None
    for o in room["objects"]:
        if o["type"] in ("loft_bed", "bunk_bed", "twin_xl_bed"):
            (_, bw, _), _ = object_dimensions(o, (2.03, 0.99, 1.75))
            if o["type"] == "twin_xl_bed":
                inner = (W / 2 - WALL_T / 2 - 0.02) - bw
            else:
                inner = W / 2 - 0.10 - bw
            bed_inner_x = inner if bed_inner_x is None else min(bed_inner_x, inner)
    if bed_inner_x is None:
        bed_inner_x = wx / 2.0 + 0.22       # no beds: hang at the window edges

    # ---- Rod: thicker horizontal cylinder (axis along X) + small end caps ----
    rod = _cyl("decor_curtain_rod", rod_r, rod_len,
               (cx, rod_y, rod_z), mats["metal_brushed"],
               props, rot=(0.0, math.radians(90), 0.0))
    _parent_keep(rod, wall)
    for tag, sx in (("l", -1.0), ("r", 1.0)):
        cap = _cyl(f"decor_curtain_rod_cap_{tag}", rod_r * 1.7, 0.02,
                    (cx + sx * rod_len / 2.0, rod_y, rod_z),
                    mats["metal_brushed"], props,
                    rot=(0.0, math.radians(90), 0.0))
        _parent_keep(cap, wall)

    # ---- Two bunched panels, one just inside each bed's head band, with
    # real drape folds: the panel is subdivided along X and displaced by a
    # raised sine so the folds read at any angle (audit F10). ----
    for tag, sx in (("l", -1.0), ("r", 1.0)):
        panel_cx = cx + sx * (bed_inner_x - 0.02 - panel_w / 2.0)
        panel = beveled_box(f"decor_curtain_panel_{tag}",
                            (panel_w, panel_t, panel_h),
                            (panel_cx, panel_y, panel_z),
                            mats["curtain_weave"], "Decor", props,
                            bevel_width=0.01, uv_tile=0.5)
        # amplitude capped at 0.04: the fold tips must stay behind the
        # centered window desk's back edge (2.5 mm proud of the old tips)
        _ripple_along_x(panel, amplitude=0.04, waves=6.0)
        _parent_keep(panel, wall)


def _ripple_along_x(obj, amplitude=0.05, waves=5.0, cuts=28):
    """Drape folds for a thin curtain panel. The base box has vertices only at
    its corners, so a sine displacement alone leaves it flat (the old panels
    read as boards — audit F10): first subdivide the X-spanning edges so there
    is geometry to bend, then displace each vertex ONE-SIDED in -Y (toward the
    room; the window wall is always at +Y) by a raised sine of its local X.
    The rest plane hugs the wall and the folds bulge up to `amplitude` into
    the room, so fold tips can never reach the wall behind the panel and stay
    clear of furniture backed near the window line. Safe no-op on failure."""
    try:
        me = obj.data
        bm = bmesh.new()
        bm.from_mesh(me)
        x_edges = [ed for ed in bm.edges
                   if abs(ed.verts[0].co.x - ed.verts[1].co.x) > 1e-6]
        bmesh.ops.subdivide_edges(bm, edges=x_edges, cuts=cuts,
                                  use_grid_fill=True)
        bm.to_mesh(me)
        bm.free()
        xs = [v.co.x for v in me.vertices]
        if not xs:
            return
        span = (max(xs) - min(xs)) or 1.0
        x0 = min(xs)
        for v in me.vertices:
            phase = (v.co.x - x0) / span
            v.co.y -= amplitude * 0.5 * (1.0 + math.sin(phase * waves * 2.0 * math.pi))
        me.update()
    except Exception:
        pass


def build_secondary_desk_props(room, mats):
    """Light staging on the desks beyond desk 1 (closed notebook + mug), so
    the other residents' desks don't read abandoned. Same local->world
    mapping as build_desk_setup; items stay on the OPEN front half."""
    if len(_ALL_DESKS) <= 1:
        return
    props = decor_props(room, attached_to="desk")
    for k, d in enumerate(_ALL_DESKS[1:], start=2):
        cx, cy, z0 = d["cx"], d["cy"], d["top"] + CONTACT_EPS
        dw, dd, face, axis = d["w"], d["d"], d["face"], d["axis"]
        open_depth = dd - d["hutch_depth"]
        open_mid_v = face * (dd / 2.0 - open_depth / 2.0)
        near_v = open_mid_v + face * (open_depth / 2.0 - 0.14)

        def L2W(u, v):
            if axis == "y":
                return cx + u, cy + v
            return cx + v, cy + u

        s = 1 if k % 2 else -1
        nb_x, nb_y = L2W(-dw * 0.18 * s, open_mid_v)
        rz = (math.radians(90) if axis == "x" else 0.0) + math.radians(8 * s)
        beveled_box(f"decor_notebook_{k}", (0.24, 0.19, 0.02),
                    (nb_x, nb_y, z0 + 0.01), mats["fabric_navy"], "Decor",
                    props, bevel_width=0.004, rot=(0, 0, rz), uv_tile=0.3)
        mug_x, mug_y = L2W(dw * 0.22 * s, near_v)
        _cyl(f"decor_mug_{k}", 0.04, 0.09,
             (mug_x, mug_y, z0 + 0.045 + CONTACT_EPS),
             mats["paint_wall"], props)


def build_wastebasket(room, mats, W, D):
    """One representative wastebasket (an officially listed furnishing) on
    the open floor past desk 1's entry-side end, clear of the nook run, the
    ladder, and the rug. Freestanding decor (no attached_to)."""
    # The published Unit 3 double sources do not establish a basket location,
    # and its former generic slot is occupied by the second tandem desk.
    if is_standard_double(room) or not _DESK1:
        return
    props = decor_props(room)
    props["notes"] = ("Wastebaskets are officially listed furnishings; one "
                      "representative basket is modeled (count/placement unverified).")
    d = _DESK1
    u = -(d["w"] / 2 + 0.14)
    v = d["face"] * (d["d"] / 2 + 0.02)
    if d["axis"] == "y":
        bx, by = d["cx"] + u, d["cy"] + v
    else:
        bx, by = d["cx"] + v, d["cy"] + u
    _cone("decor_wastebasket", 0.10, 0.125, 0.30,
          (bx, by, CONTACT_EPS + 0.15), mats["metal_brushed"], props)


def build_mirrors(room, mats, W, D):
    """Vanity mirror (+ light bar where the wall above is free) on the side
    wall over each recorded side-wall dresser — the official page lists a
    closet/mirror/light per resident; one representative vanity is modeled
    per dresser and the count caveat stays in the schema notes. Parented to
    the wall for dollhouse culling."""
    # Double mirrors/lights are integral to the two open entry alcoves. Do not
    # duplicate them as tiny dresser-mounted vanity slivers.
    if is_standard_double(room) or not _DRESSERS:
        return
    has_loft = any(o["type"] == "loft_bed" for o in room["objects"])
    props = decor_props(room, attached_to="dresser")
    props["notes"] = ("Representative vanity; the official page lists a "
                      "mirror/light per resident (placement unverified).")
    for i, d in enumerate(_DRESSERS, start=1):
        w_name = d["wall"]
        wall = bpy.data.objects.get(
            {"left": "wall_left", "right": "wall_right", "entry": "wall_entry"}[w_name])
        # the double hangs bookshelves at 1.15/1.55 above its dressers, so
        # its mirror is a shorter vanity panel below them; the triple's wall
        # is free above the dresser, so it gets a taller mirror + light bar
        if has_loft:
            m_z0, m_z1 = 1.00, 1.55
        else:
            m_z0, m_z1 = 0.85, 1.12
        m_h = m_z1 - m_z0
        m_zc = (m_z0 + m_z1) / 2
        if w_name == "entry":
            wall_face = -(D / 2 - WALL_T / 2)
            frame_sz = (0.42, 0.014, m_h)
            face_sz = (0.36, 0.006, m_h - 0.06)
            frame_loc = (d["px"], wall_face + 0.02 + 0.007, m_zc)
            face_loc = (d["px"], wall_face + 0.02 + 0.014 + 0.003 + CONTACT_EPS, m_zc)
            bar_sz = (0.30, 0.05, 0.05)
            bar_loc = (d["px"], wall_face + 0.02 + 0.025, m_z1 + 0.10)
        else:
            side = 1 if w_name == "right" else -1
            wall_face = side * (W / 2 - WALL_T / 2)
            frame_sz = (0.014, 0.42, m_h)
            face_sz = (0.006, 0.36, m_h - 0.06)
            frame_loc = (wall_face - side * (0.02 + 0.007), d["py"], m_zc)
            face_loc = (wall_face - side * (0.02 + 0.014 + 0.003 + CONTACT_EPS),
                        d["py"], m_zc)
            bar_sz = (0.05, 0.30, 0.05)
            bar_loc = (wall_face - side * (0.02 + 0.025), d["py"], m_z1 + 0.10)
        frame = beveled_box(f"decor_mirror_{i}_frame", frame_sz, frame_loc,
                            mats["paint_wall"], "Decor", props, uv_tile=0.3)
        face = beveled_box(f"decor_mirror_{i}_face", face_sz, face_loc,
                           mats["metal_brushed"], "Decor", props, uv_tile=0.2)
        pieces = [frame, face]
        if has_loft:
            pieces.append(beveled_box(f"decor_vanity_light_{i}", bar_sz, bar_loc,
                                      mats["paint_wall"], "Decor", props, uv_tile=0.2))
        for ob in pieces:
            if wall:
                _parent_keep(ob, wall)


def build_decor(room, mats, W, D):
    """Assemble all M1 lived-in staging. Called after every furniture/opening
    builder so the placement descriptors (_SLEEP_SURFACES, _DESK1, _WINDOW) are
    populated."""
    build_bed_dressing(room, mats)
    build_area_rug(room, mats, W, D)
    build_desk_setup(room, mats)
    build_secondary_desk_props(room, mats)
    build_wastebasket(room, mats, W, D)
    build_curtains(room, mats, W)
    build_mirrors(room, mats, W, D)


# --------------------------------------------------------------------------
# Lighting / camera (no labels — viewer draws HTML badges)
# --------------------------------------------------------------------------

def add_lighting(room, W, D, H):
    bpy.ops.object.light_add(type="AREA", location=(0, 0, H - 0.25))
    light = bpy.context.object
    light.name = "ceiling_area_light"
    light.data.energy = 220
    light.data.size = 3.5
    link_to_collection(light, "Lights")

    bpy.ops.object.camera_add(location=(0, -D * 1.35, H * 1.15),
                              rotation=(math.radians(64), 0, 0))
    camera = bpy.context.object
    camera.name = "preview_camera"
    link_to_collection(camera, "Cameras")
    bpy.context.scene.camera = camera


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def _name_is_known(name):
    if name in SHELL_NAMES:
        return True
    if name.startswith(WALL_PREFIX):
        return True
    if name.startswith(TRIM_PREFIX):
        return True
    if name.startswith(DECOR_PREFIX):
        return True
    for p in FURNITURE_PREFIXES:
        if name == p or name.startswith(p + "_"):
            return True
    return False


def validate_scene(room):
    errors = []
    mesh_objs = [o for o in bpy.data.objects if o.type == "MESH"]
    object_names = {o.name for o in bpy.data.objects}

    for required in ["floor", "ceiling", "wall_entry", "wall_back_window"]:
        if required not in object_names:
            errors.append(f"Missing required shell object: {required}")
    if not any(o.name.startswith("door") for o in mesh_objs):
        errors.append("Missing door object")
    if not any(o.name.startswith("window") for o in mesh_objs):
        errors.append("Missing window object")

    # Name discipline: every mesh maps to exactly one known prefix / shell / trim.
    for o in mesh_objs:
        if not _name_is_known(o.name):
            errors.append(f"Unknown mesh name (no known prefix/shell/trim): {o.name}")
        # exactly-one-prefix check for furniture names
        matches = [p for p in FURNITURE_PREFIXES if o.name == p or o.name.startswith(p + "_")]
        if len(matches) > 1:
            errors.append(f"Ambiguous prefix for {o.name}: matches {matches}")

    # Texture coverage: images must exist and be packed.
    packed = [img for img in bpy.data.images if img.packed_file is not None]
    if len(packed) < 3:
        errors.append(f"Textures missing/not packed (found {len(packed)} packed images)")

    # Metadata coverage: every mesh must carry the 9 custom-prop keys.
    required_keys = {
        "school", "hall", "room_type", "accuracy_tier", "representative_model",
        "source_id", "confidence", "dimension_status", "estimated_dimensions_warning",
    }
    for o in mesh_objs:
        missing = required_keys - set(o.keys())
        if missing:
            errors.append(f"{o.name} missing custom props: {sorted(missing)}")

    # Decor discipline: exactly the decor_* nodes carry decorative=true, and
    # every decor_* node carries the correct attached_to (or none for
    # freestanding rug/curtains).
    valid_attach = {"loft_bed", "bunk_bed", "twin_xl_bed", "desk", "dresser"}
    decor_meshes = [o for o in mesh_objs if o.name.startswith(DECOR_PREFIX)]
    for o in mesh_objs:
        is_decor = o.name.startswith(DECOR_PREFIX)
        has_flag = str(o.get("decorative", "")).lower() == "true"
        if is_decor and not has_flag:
            errors.append(f"decor node {o.name} missing decorative=true")
        if (not is_decor) and has_flag:
            errors.append(f"non-decor node {o.name} carries decorative=true")
    for o in decor_meshes:
        att = o.get("attached_to")
        is_dressing = o.name.startswith("decor_duvet_") or o.name.startswith("decor_pillow_")
        is_desk_item = any(o.name.startswith(p) for p in (
            "decor_lamp_", "decor_laptop", "decor_book", "decor_mug",
            "decor_notebook"))
        is_vanity = o.name.startswith(("decor_mirror_", "decor_vanity_light_"))
        if is_dressing or is_desk_item or is_vanity:
            if att not in valid_attach:
                errors.append(f"decor node {o.name} has invalid/missing attached_to: {att!r}")
        else:
            # rug + curtains are freestanding: they must NOT carry attached_to
            if att not in (None, ""):
                errors.append(f"freestanding decor node {o.name} unexpectedly carries attached_to={att!r}")

    # Evidence-backed canonical-double invariants. These are deliberately
    # structural (names/transforms/counts), so a future polish pass cannot
    # silently regress the layout into the disproven hybrid configuration.
    if is_standard_double(room):
        by_name = {o.name: o for o in mesh_objs}

        def require(name):
            obj = by_name.get(name)
            if obj is None:
                errors.append(f"Double invariant missing node: {name}")
            return obj

        def world_bounds(obj):
            corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
            return (
                Vector((min(p.x for p in corners), min(p.y for p in corners), min(p.z for p in corners))),
                Vector((max(p.x for p in corners), max(p.y for p in corners), max(p.z for p in corners))),
            )

        def overlaps(first, second, tolerance=0.001):
            a_min, a_max = world_bounds(first)
            b_min, b_max = world_bounds(second)
            return all(
                min(a_max[axis], b_max[axis]) - max(a_min[axis], b_min[axis]) > tolerance
                for axis in range(3)
            )

        desk_1 = require("desk_1_top")
        desk_2 = require("desk_2_top")
        if desk_1 and desk_2:
            p1 = desk_1.matrix_world.translation
            p2 = desk_2.matrix_world.translation
            if abs(p1.x - p2.x) > 0.01 or abs(p1.x) > 0.01:
                errors.append(
                    f"Double desks must share x=0 (got {p1.x:.3f}, {p2.x:.3f})"
                )
            min_tandem_sep = min(desk_1.dimensions.y, desk_2.dimensions.y) * 0.85
            if abs(p1.y - p2.y) < min_tandem_sep:
                errors.append(
                    "Double desks must be distinct tandem stations along Y "
                    f"(separation {abs(p1.y - p2.y):.3f})"
                )

        chair_1 = require("chair_1_seat")
        chair_2 = require("chair_2_seat")
        if chair_1 and chair_2:
            c1x = chair_1.matrix_world.translation.x
            c2x = chair_2.matrix_world.translation.x
            if not (c1x < -0.05 and c2x > 0.05):
                errors.append(
                    "Double chairs must provide opposite-side access "
                    f"(chair X positions {c1x:.3f}, {c2x:.3f})"
                )

        pane_names = {o.name for o in mesh_objs if o.name.startswith("window_1_glass_")}
        if pane_names != {"window_1_glass_left", "window_1_glass_right"}:
            errors.append(f"Double window must have exactly two panes (got {sorted(pane_names)})")
        require("window_1_frame_center")
        floor = require("floor")

        for side in ("left", "right"):
            require(f"trim_radiator_{side}_back")
            if not any(o.name.startswith(f"trim_radiator_{side}_fin_") for o in mesh_objs):
                errors.append(f"Double radiator {side} has no fins")
            curtain = require(f"decor_curtain_panel_{side[0]}")
            radiator_parts = [
                o for o in mesh_objs if o.name.startswith(f"trim_radiator_{side}_")
            ]
            if curtain and any(overlaps(curtain, part) for part in radiator_parts):
                errors.append(f"Double curtain {side} intersects its radiator")

        for idx in (1, 2):
            for name in (
                f"closet_{idx}_alcove_back",
                f"closet_{idx}_alcove_left",
                f"closet_{idx}_alcove_right",
                f"closet_{idx}_drawer_carcass",
                f"closet_{idx}_drawer_1_front",
                f"closet_{idx}_hanging_rod",
                f"closet_{idx}_mirror_face",
                f"closet_{idx}_globe_light",
            ):
                require(name)
            if any(o.name.startswith(f"closet_{idx}_door_") for o in mesh_objs):
                errors.append(f"Double closet {idx} regressed to a closed wardrobe")
            for end in ("head", "foot"):
                require(f"twin_xl_bed_{idx}_{end}_rail_lower")
                require(f"twin_xl_bed_{idx}_{end}_rail_upper")
            require(f"twin_xl_bed_{idx}_frame_side_left")
            require(f"twin_xl_bed_{idx}_frame_side_right")
            if f"twin_xl_bed_{idx}_frame" in by_name:
                errors.append(f"Double bed {idx} regressed to a solid plinth")
            if any(o.name.startswith(f"twin_xl_bed_{idx}_leg_") for o in mesh_objs):
                errors.append(f"Double bed {idx} duplicated its end posts with generic legs")

        if any("_shelfcol_" in o.name for o in mesh_objs):
            errors.append("Double must not duplicate storage with a closet shelf column")

        closet_1 = require("closet_1_kick")
        closet_2 = require("closet_2_kick")
        if closet_1 and closet_2:
            x1 = closet_1.matrix_world.translation.x
            x2 = closet_2.matrix_world.translation.x
            if abs(x1 + x2) > 0.01 or abs(closet_1.dimensions.x - closet_2.dimensions.x) > 0.01:
                errors.append("Double entry closet alcoves must be mirror-symmetric")

        require("microchill_1_door")
        require("microchill_1_microwave_face")
        require("microchill_1_microwave_window")
        micro_body = require("microchill_1_body")
        fixture_nodes = [
            o for o in mesh_objs
            if o.name.startswith(("closet_1_mirror_", "closet_1_globe_light"))
        ]
        if micro_body and any(overlaps(micro_body, fixture) for fixture in fixture_nodes):
            errors.append("Double Microchill intersects the left closet mirror/light")
        if "decor_rug_1" in by_name:
            errors.append("Canonical double must not add an unsupported area rug")
        if "decor_wastebasket" in by_name:
            errors.append(
                "Canonical double must not place an unverified wastebasket in the tandem desk run"
            )

        for idx in (1, 2):
            for name in (
                f"bookshelf_{idx}_board_1",
                f"bookshelf_{idx}_board_2",
                f"bookshelf_{idx}_side_-1",
                f"bookshelf_{idx}_side_1",
            ):
                shelf = require(name)
                if shelf:
                    if shelf.get("source_id") != "berkeley_housing_unit3":
                        errors.append(f"{name} has incorrect bookshelf provenance")
                    if shelf.get("dimension_status") != "unknown":
                        errors.append(f"{name} must keep unknown dimensions")
        if any(o.name.startswith("dresser_") and "_shelf_" in o.name for o in mesh_objs):
            errors.append("Double wall bookshelves must not inherit movable dresser names")

        for idx in (1, 2):
            for suffix in ("mirror_frame", "mirror_face"):
                fixture = require(f"closet_{idx}_{suffix}")
                if fixture and fixture.get("dimension_status") != "unknown":
                    errors.append(f"Double closet {idx} mirror dimensions must remain unknown")
            light = require(f"closet_{idx}_globe_light")
            if light and light.get("dimension_status") != "unknown":
                errors.append(f"Double closet {idx} light dimensions must remain unknown")
        if floor and (not floor.data.materials or floor.data.materials[0].name != "carpet_charcoal"):
            errors.append("Double floor must use the charcoal/brown carpet material")

    print("\nMODEL VALIDATION")
    print(f"  mesh objects: {len(mesh_objs)}")
    print(f"  decor meshes: {len(decor_meshes)}")
    print(f"  packed textures: {len(packed)}")
    if errors:
        for e in errors:
            print("FAIL:", e)
    else:
        print("PASS: Scene checks passed (names, textures, metadata, openings).")
    if any(
        room_geometry_axis(room, axis)[2] == "visualization_shell"
        for axis in ("width", "depth", "height")
    ):
        print("NOTE: Room geometry uses visualization estimates. Do not treat as verified.")
    return errors


# --------------------------------------------------------------------------
# Build orchestration
# --------------------------------------------------------------------------

def build(room):
    global _SLEEP_SURFACES, _DESK1, _WINDOW, _LOFT_LADDER, _WINDOW_DESK, \
        _DRESSERS, _OPEN_FLOOR_Y_HI, _ALL_DESKS
    _SLEEP_SURFACES = []
    _DESK1 = None
    _WINDOW = None
    _LOFT_LADDER = None
    _WINDOW_DESK = None
    _DRESSERS = []
    _OPEN_FLOOR_Y_HI = None
    _ALL_DESKS = []
    clear_scene()
    ensure_collections()
    generate_textures(room)
    mats = make_materials(room)
    W, D, H, wall_objs, shell_props = build_shell(room, mats)
    build_openings(room, mats, W, D, H, wall_objs, shell_props)
    build_loft_bed(room, mats, W, D)
    build_bunk_bed(room, mats, W, D)
    build_twin_beds(room, mats, W, D)
    build_chairs_and_desks(room, mats, W, D)
    build_storage(room, mats, W, D)
    build_decor(room, mats, W, D)
    add_lighting(room, W, D, H)
    return validate_scene(room)


def main():
    args = parse_args()
    schema_path = Path(args.schema)
    with schema_path.open("r", encoding="utf-8") as f:
        room = json.load(f)

    errors = build(room)
    if errors:
        print("Scene validation failed; not exporting. Fix the errors above and re-run.")
        sys.exit(1)

    blend_path = Path(args.blend)
    glb_path = Path(args.out)
    blend_path.parent.mkdir(parents=True, exist_ok=True)
    glb_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_extras=True,
    )
    print(f"Saved Blender file: {blend_path}")
    print(f"Saved GLB: {glb_path}")


if __name__ == "__main__":
    main()
