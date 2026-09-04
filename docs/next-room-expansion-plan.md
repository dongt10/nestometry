# Room Expansion Plan

The current pipeline supports only Unit 3 standard double and triple representative examples. The long-term coverage goal is a visual catalog of UC Berkeley residence halls and apartments, including documented room and unit variants wherever safe, shareable evidence is available.

## Reusable pipeline

1. Record public evidence in `packages/berkeley-data/source-ledger/`.
2. Add a schema 0.3.0 room record under `packages/berkeley-data/halls/`.
3. Keep exact unknown axes in `room_shell`; add sourced estimated axes in `visualization_shell`.
4. Define the canonical `visualization_scene`: stable instance poses and roles, cameras, surfaces, openings, and advisory clearance zones.
5. Validate the room record.
6. Generate and optimize the Blender/GLB artifacts and derived collider manifest.
7. Add the room and both runtime asset paths to `apps/web/src/data/assetManifest.ts`.
8. Add schema, coordinate, collision, geometry, and browser coverage.
9. Refresh the missing-dimension, QA, and provenance records.

For each geometry axis, a usable verified `room_shell` value wins; otherwise geometry uses the corresponding `visualization_shell` estimate. Public exact-dimension labels still read only from `room_shell`. Blender, the browser's initial 3D state, and the SVG plan must use the same `visualization_scene` poses rather than adding room-specific placement branches.

Every `layout_constraints[].subject` and `.object` must name a declared room
object/group, exact scene instance, or architectural surface. Add separate
constraints when one claim applies to multiple independently declared objects;
do not introduce undeclared free-form aggregate names.

## Candidate sequence

1. Unit 1 standard double and triple
2. Unit 2 standard double and triple
3. Unit 1/2 mini-suites
4. Blackwell single and double
5. Stern room types
6. Foothill and Clark Kerr suite archetypes
7. Martinez Commons room types
8. University apartment communities and unit archetypes

This order is only a starting point; a well-sourced contribution can advance any UC Berkeley housing type. Each hall, apartment community, and meaningful variant needs its own sources. Similar architecture is not evidence that furniture, openings, or dimensions are identical.

## Expected generator extensions

- linked multi-space or suite shells;
- bathroom fixtures for authorized in-suite examples;
- explicit room-variant identifiers;
- reusable parametric construction for additional furniture and fixture types;
- multi-space scene/collider manifests; and
- evidence-backed clearance zones for kitchens, baths, and shared circulation.

Do not begin a room until its source and privacy boundaries are clear. Run `corepack pnpm verify` and the Blender regeneration checks before accepting it.
