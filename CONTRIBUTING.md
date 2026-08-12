# Contributing

Thanks for helping improve the viewer. Nestometry is incomplete by design and welcomes contributors of every experience level. The long-term goal is to represent UC Berkeley residence halls and apartments wherever safe, shareable evidence is available. Accuracy and privacy matter more than visual completeness.

## Ways to contribute

You do not need Blender or Three.js experience to help. Useful contributions include:

- finding and documenting public, authoritative room sources;
- recording permitted measurements with clear provenance;
- adding a residence-hall, apartment, room, or layout variant;
- improving room data, the procedural generator, or the 2D and 3D viewer;
- improving accessibility, performance, automated tests, documentation, or QA; and
- reporting an inaccuracy, missing source, confusing interaction, or useful feature request.

Small, focused contributions are welcome. You can correct one source, dimension status, furniture detail, test, or paragraph without taking responsibility for a complete building. If you want to add a new housing type, start with the [room expansion plan](docs/next-room-expansion-plan.md) and open an issue describing the public evidence you found.

## Before contributing

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE). Only contribute work you have the right to license, and preserve any required third-party notices.

Do not submit:

- private or occupied-room photos;
- student names, belongings, room numbers, or other personal information;
- restricted drawings or security-sensitive building details;
- scraped virtual-tour assets, copied panoramas, meshes, or textures; or
- material you do not have the right to share.

## Accuracy corrections

Open an accuracy-correction issue with a public source URL, access date, the exact observed fact, and the affected room or object. Clearly separate facts from estimates. A different valid room configuration is a variant, not proof that every other example is wrong.

Exact dimensions require an official published measurement, an authorized measurement, or a permitted drawing. Visual estimates belong in `visualization_shell`; unknown exact values remain `null` in `room_shell`.

## Local checks

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm exec playwright install chromium
corepack pnpm verify
```

When changing generated geometry, also rebuild the affected room with Blender 5.1.1, validate the model, and confirm that the source and public GLBs are byte-identical.

## Change discipline

- Keep direct dependencies exact-pinned.
- Do not commit `.env*`, local tool state, reference packs, or Blender backup files.
- Avoid mass formatting unrelated files.
- Update room data, source ledger, tests, generated artifacts, and QA evidence together when a model fact changes.
- Keep pull requests focused and explain any remaining uncertainty.

Security reports follow [SECURITY.md](SECURITY.md), not the public issue tracker.
