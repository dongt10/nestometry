# Source, Privacy, and Release Policy

This policy is a project safeguard, not legal advice or a substitute for source-specific permission.

## Independence and names

The project is independent and is not affiliated with or endorsed by UC Berkeley or the Regents of the University of California. Institutional names are used only to identify the subject of the representative room records. Do not add official logos, seals, or presentation that implies endorsement without written authorization.

Public repository visibility is not a license. Project and third-party reuse rights are controlled by the applicable license and source terms.

## Source priority

Use sources in this order:

1. Official housing pages and directly published room descriptions.
2. Official housing videos and representative renderings.
3. Permitted facilities documents.
4. Official manufacturer specifications.
5. Authorized measurements of unoccupied rooms.
6. Public secondary references only as corroboration, with privacy and reuse review.

Every material claim should identify its source, access date, confidence, and whether it is observed, estimated, or verified.

## Source media

Public availability does not grant permission to copy or redistribute media. Do not scrape, download for redistribution, reconstruct, rip, or ship virtual-tour or reference assets unless an explicit license or written permission allows it.

Allowed:

- record factual observations about a public representative layout;
- link to the original public source;
- create original procedural geometry and materials; and
- keep private, lawfully obtained look-only working references outside Git.

Not allowed:

- ship screenshots, panoramas, photos, meshes, or textures copied from a source;
- automate extraction from a virtual-tour viewer;
- present an internal reference archive as a reproducible public source; or
- remove attribution or license notices from permitted third-party material.

## Student privacy

Do not commit, publish, or model occupied/private student spaces without specific authorization and consent. Exclude people, names, room numbers, mail, IDs, calendars, whiteboards, personal belongings, and other identifying information.

## Sensitive building information

Do not publish access-control details, exact security layouts, restricted routes, mechanical/electrical spaces, controlled drawings, or nonpublic infrastructure. If a permitted drawing is used, publish only approved non-sensitive derived facts and follow its safeguarding and disposal conditions.

## Accuracy and release rule

Every shipped room must include:

- a public source basis where one exists;
- an accuracy tier;
- a room-variation warning when applicable;
- explicit verified, estimated, or unknown dimension status; and
- a current QA and provenance review.

Unknown exact values stay unknown. Estimated visualization geometry is not a fit guarantee or an assigned-room measurement.

## Application privacy

The checked-in planner does not implement accounts, analytics, advertising,
uploads, or client-side tracking. It stores compatible per-room plans and UI
preferences in browser local storage. An explicit share link places a bounded,
compressed plan in the URL fragment, which browsers do not send in ordinary
HTTP requests. The fragment is not secret: anyone with the link can decode and
edit its layout and custom labels, and browser sync/history, clipboards, link
previews, or messaging services may retain the URL. Do not enter personal or
sensitive information in planner labels.

A deployment host may retain ordinary request logs under its own policy;
document that host separately when deploying.
