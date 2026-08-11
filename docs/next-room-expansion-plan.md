# Room Expansion Plan

The current pipeline supports Unit 3 standard double and triple representative examples.

## Reusable pipeline

1. Record public evidence in `packages/berkeley-data/source-ledger/`.
2. Add a schema 0.2.0 room record under `packages/berkeley-data/halls/`.
3. Keep exact unknown axes in `room_shell`; add sourced estimated axes in `visualization_shell`.
4. Validate the room record.
5. Generate and optimize the Blender/GLB artifacts.
6. Add the room to `apps/web/src/data/assetManifest.ts`.
7. Add schema, geometry, and browser coverage.
8. Refresh the missing-dimension, QA, and provenance records.

For each geometry axis, a usable verified `room_shell` value wins; otherwise the generator and 2D view use the corresponding `visualization_shell` estimate. Public exact-dimension labels still read only from `room_shell`.

## Candidate sequence

1. Unit 1 standard double and triple
2. Unit 2 standard double and triple
3. Unit 1/2 mini-suites
4. Blackwell single and double
5. Stern room types
6. Foothill and Clark Kerr suite archetypes
7. Martinez Commons room types

Each hall needs its own sources. Similar architecture is not evidence that furniture, openings, or dimensions are identical.

## Expected generator extensions

- linked multi-space or suite shells;
- bathroom fixtures for authorized in-suite examples;
- explicit room-variant identifiers;
- movable versus built-in furniture metadata; and
- more general 2D layout projection for rooms without a dedicated canonical layout.

Do not begin a room until its source and privacy boundaries are clear. Run `corepack pnpm verify` and the Blender regeneration checks before accepting it.
