# Unit 3 Source and Provenance Review

Review date: 2026-08-10

Scope: checked-in Unit 3 double/triple data, generated models, and viewer

Purpose: source, privacy, and provenance triage; not legal advice or an unconditional publication clearance

## Project identity

The viewer is presented as an independent student project and states that it is not affiliated with or endorsed by UC Berkeley or the Regents of the University of California. It does not ship an official seal, logo, or copied institutional artwork.

## External sources

The room records link to the original public Berkeley Housing pages, published representative views, official videos, and Facilities request process. They use those sources for factual observations and warnings. A private look-only analysis archive has no public URL and is described only as an internal basis for estimates.

No virtual-tour panorama, source screenshot, official photo, imported room mesh, or copied source texture is committed or embedded in a production artifact.

## Generated assets

The Blender generator creates original parametric geometry and procedural textures. Current optimized artifacts contain:

- double: 30 embedded WebP images and 12 materials;
- triple: 33 embedded WebP images and 13 materials; and
- zero external asset URIs in either GLB.

The procedural texture code is deterministic and checked in. Both editable Blender files are packed and contain no external library links. The source/public GLB pairs are byte-identical.

## Accuracy and attribution

- The tier is `official_representative`, not measured or drawing-verified.
- Exact shell dimensions remain unknown.
- Visualization estimates identify source, confidence, estimated status, and notes.
- The official room-variation warning is visible in the viewer.
- Different room examples are represented as variants rather than universal facts.

## Privacy and sensitive information

The current publishable tree contains no student photos, names, room numbers, mail, IDs, occupied-room scans, access-control details, restricted drawings, or nonpublic building infrastructure. The application implements no accounts, uploads, analytics, or client-side tracking.

The public branch is prepared as a clean root snapshot so obsolete local paths, transient runtime state, and repeated binary revisions are not part of its reachable history. An older archival branch remains local-only and must not be published.

## License and name-use status

The project is released under the MIT License. UC Berkeley names and marks and any third-party source material remain the property of their respective owners and are not granted by the project license.

The current tree uses the neutral project name Nestometry and a non-affiliation disclaimer. Any future decision to adopt official-looking naming, logos, or institutional brand colors should be reviewed against the applicable name-use policy or written authorization.

## Conclusion

The current artifacts have a documented original-generation path and no copied source media was found. Technical provenance, privacy, licensing, clean-history, author-identity, and neutral-branding checks support the local public release candidate. Publication still requires an explicit final approval and an explicit push of only the clean public branch.
