# Nestometry Web Planner

The Next.js application renders the validated room records and local GLB models. It has no application API, authentication, uploads, analytics, or remote model catalog.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Runtime models and collider manifests live under
`apps/web/public/models/berkeley/` and must remain byte-identical to their source
copies under `assets/glb/berkeley/` and `assets/colliders/berkeley/`. The runtime
validates collider room and scene revisions. `corepack pnpm audit:public` also
binds every collider manifest to its optimized GLB SHA-256; deploy those paired
files atomically so a partially updated static host cannot mix revisions.

Room geometry resolves each axis from a verified `room_shell` value when one exists, otherwise from the required sourced `visualization_shell` estimate. Dimension tables and badges continue to read `room_shell`, so an unmeasured axis is displayed as unknown rather than exposing the visualization estimate as exact.

Planner documents are versioned and strictly parsed. Compatible documents are
saved per room in `localStorage`; a shared document takes precedence only when
its room, scene revision, canonical instance set, and schema all match. Share
payloads are limited to a 32 KiB decompressed document and an 8,000-character
URL fragment. Fragments are bearer-readable and may include user-entered labels,
so the interface and project policy tell users not to include sensitive data.

Complete room JSON records are imported into the client. Every field—including
the legacy-named `internal_notes` field—must therefore contain publishable-only
content.

Run `corepack pnpm verify` from the root for lint, type, schema, unit, build, audit, and browser checks.
