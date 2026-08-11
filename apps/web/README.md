# Nestometry Web Viewer

The Next.js application renders the validated room records and local GLB models. It has no application API, authentication, uploads, analytics, or remote model catalog.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Runtime models live under `apps/web/public/models/berkeley/` and must remain byte-identical to the corresponding files under `assets/glb/berkeley/`.

Room geometry resolves each axis from a verified `room_shell` value when one exists, otherwise from the required sourced `visualization_shell` estimate. Dimension tables and badges continue to read `room_shell`, so an unmeasured axis is displayed as unknown rather than exposing the visualization estimate as exact.

Run `corepack pnpm verify` from the root for lint, type, schema, unit, build, audit, and browser checks.
