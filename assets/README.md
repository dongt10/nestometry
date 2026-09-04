# Assets

Production assets only.

Allowed:

- generated `.glb` files
- generated `.blend` files, if you want to version them
- generated `.colliders.json` planning manifests under `assets/colliders/`
- original/procedural textures
- licensed assets with clear license records

Not allowed:

- scraped virtual-tour panoramas
- copied source screenshots
- copied textures from photos
- private student-room photos

For internal reference screenshots, use `research/screenshots-private-not-for-release/` and keep it out of git.

Collider manifests are derived from the final generated mesh bounds in each
stable instance root's local room-coordinate frame. They are not survey data or
fit guarantees. Each manifest records numeric `manifest_version: 1`, the room
ID, room-scene revision, and optimized GLB hash so browser consumers can reject
stale combinations.

The browser validates room and scene revision before using a manifest. The
release gate additionally checks `asset_sha256` against the optimized GLB and
requires source/public copies to be byte-identical. Static deployments must
publish each GLB and its collider manifest atomically.
