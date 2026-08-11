# Nestometry

Source-backed dorm rooms in 2D and 3D. Nestometry is an interactive viewer for representative dorm-room layouts; the current dataset covers standard double and triple examples for Unit 3 at UC Berkeley.

> **Unofficial project:** This is an independent student project. It is not affiliated with, endorsed by, or an official service of UC Berkeley or the Regents of the University of California. Room models are representative examples, not assigned-room digital twins.

## What it does

- Loads optimized GLB room models in a browser-based Three.js viewer.
- Switches between orbit, top-down, and first-person views.
- Shows furniture groups and honest dimension badges.
- Supports session-only furniture arrangement and reset.
- Preserves room, view, and display state in a shareable URL.
- Displays source provenance, confidence, accuracy tier, and Berkeley's room-variation warning.

The checked-in rooms are `official_representative`. No official drawings or authorized measurements have been obtained. Exact `room_shell` dimensions therefore remain `unknown`; separately sourced `visualization_shell` estimates drive geometry and are never presented as verified measurements.

## Quick start

Requirements:

- Node.js 20.19 or newer
- Corepack
- Chromium installed through Playwright for end-to-end tests

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Verification

Run the complete application check:

```bash
corepack pnpm verify
```

That runs the production dependency audit, ESLint, Next.js type generation and TypeScript, Vitest, both room-schema validations, public-tree and artifact-integrity checks, a production build, and Playwright Chromium smoke tests.

Individual commands are also available:

```bash
corepack pnpm audit:prod
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm validate:rooms
corepack pnpm audit:public
corepack pnpm build
corepack pnpm test:e2e
```

## Regenerating the models

The generated geometry and textures are original, procedural output from the Blender Python generator. Reference images, virtual-tour panoramas, and copied source textures are not distributed.

The current artifacts were verified with Blender 5.1.1. Set `BLENDER_BIN` when Blender is not on `PATH`:

```bash
BLENDER_BIN=/path/to/blender corepack pnpm demo:unit3
```

This validates both room records, rebuilds the `.blend` and optimized `.glb` files, copies the public GLBs, and builds the web app. See [packages/blender-generators/README.md](packages/blender-generators/README.md) for the geometry and naming contracts.

## Repository layout

```text
apps/web/                         Next.js viewer and browser tests
packages/room-schema/             Zod room-data contract
packages/berkeley-data/           Room records and source ledger
packages/blender-generators/      Procedural Blender generator
assets/blend/                     Editable generated Blender files
assets/glb/                       Optimized source GLBs
apps/web/public/models/           Public runtime GLB copies
docs/                             Accuracy and source-use policies
research/                         Public research notes and measurement backlog
reports/                          Reproducible QA and provenance summaries
```

## Accuracy and source policy

The project follows an evidence-first pipeline:

```text
public source ledger -> validated room data -> procedural generator -> GLB -> viewer -> QA
```

Important rules:

- Unknown exact dimensions stay unknown.
- Every geometry estimate identifies its source, confidence, and estimated status.
- Published room examples may vary in size, layout, and furniture configuration.
- Public references are used for factual observation only; source media is not copied into the project.
- Occupied-room media, personal student information, restricted drawings, and security-sensitive building details must not be committed.

Read [docs/data-accuracy-tiers.md](docs/data-accuracy-tiers.md), [docs/legal-and-privacy-policy.md](docs/legal-and-privacy-policy.md), and [packages/berkeley-data/source-ledger/unit-3.md](packages/berkeley-data/source-ledger/unit-3.md) before adding a room.

## Security and privacy

The viewer has no accounts, analytics, uploads, application backend, or client-side tracking. A deployment provider may still collect standard request logs under its own policy. Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Accuracy corrections should include a public source and should distinguish observed facts from estimates.

## License

Nestometry is released under the [MIT License](LICENSE). UC Berkeley names and marks and any third-party source material remain the property of their respective owners and are not granted by this license.
