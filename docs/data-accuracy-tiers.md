# Data Accuracy Tiers

Use these tiers everywhere: source cards, JSON schema, UI badges, QA reports, and release notes.

## Tier 0 — `conceptual`

Looks like a plausible dorm room but is not tied to a specific official room type.

Allowed use:

- early visual tests
- furniture module prototyping
- viewer development

Not allowed:

- student-facing claims of accuracy
- measurements

## Tier 1 — `official_representative`

Based on official UC Berkeley Housing pages, official videos, and public official renderings/floor-plan references.

Allowed use:

- representative room-type model
- furniture count and layout relationships, if source-backed
- “rooms vary” warning required

Not allowed:

- exact dimensions unless official source gives them
- exact assigned-room claims

## Tier 2 — `measured_representative`

Based on manual measurement or authorized scan of one representative room of a type.

Allowed use:

- measured shell dimensions for that sample room
- measured furniture dimensions for that sample

Required:

- measurement date
- person/team who measured
- measurement method
- uncertainty notes

## Tier 3 — `drawing_verified`

Based on official architectural/facilities drawings or equivalent verified documents.

Allowed use:

- exact shell geometry for documented room type or room number
- higher-confidence measurements

Required:

- drawing source ID
- drawing date/version
- permission/access notes

## Tier 4 — `room_specific_digital_twin`

Verified for a specific room number with official drawings plus authorized room-specific measurement/scan.

Allowed use:

- assigned room previews
- exact fit planning

Required:

- explicit authorization
- privacy review
- sensitivity review
- room-number publishing decision
