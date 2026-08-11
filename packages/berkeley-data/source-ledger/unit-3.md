# Source Ledger — UC Berkeley Unit 3

The official Unit 3 page and its direct double-render assets were re-verified live on **2026-08-10**. Older research sources retain their individual access dates below (see `research/notes/unit-3-research-notes.md`).

## Source IDs

### `berkeley_housing_unit3`

- Title: Unit 3 — UC Berkeley Housing residence hall page
- URL: https://housing.berkeley.edu/explore-housing-options/residence-halls/unit-3/
- Source type: official_housing_page
- Access date: 2026-08-10 (live)
- Use for: layout, furniture, room-type inventory, variation warnings, visual references
- Confidence: high for official descriptions; the page states **no numeric dimensions or square footage**

### `berkeley_housing_unit3_double_published_3d`

- Title: UC Berkeley Housing — Unit 3 double published 3D floor plan
- Top view: https://housing.berkeley.edu/wp-content/uploads/double_top-250px.jpg
- Entrance view: https://housing.berkeley.edu/wp-content/uploads/double_side_01-250px.jpg
- Source type: official_housing_page
- Access date: 2026-08-10 (both direct assets live and embedded on the live Unit 3 page)
- Use for: canonical standard-double relative layout, furniture count/orientation, and visual reference
- Confidence: high for what the images show; **no numeric dimensions are published**

### `berkeley_housing_unit3_double_tour_2020`

- Title: UCBStudentAffairs — UC Berkeley Housing Mini Tour: Unit 3, Double Room
- URL: https://www.youtube.com/watch?v=aS5EwS9VjH4
- Source type: official_video
- Published: 2020-04-23
- Use for: documented Unit 3 double variation and physical-furniture reference
- Confidence: high for that toured room; it shows two desks side-by-side at the window and is **not** blended into the canonical published-3D variant

### `berkeley_housing_highrise_double_analog`

- Title: UCBStudentAffairs — Sample UC Berkeley High-Rise Double Room
- URL: https://www.youtube.com/watch?v=O_PIZTMsdYA
- Source type: official_video
- Use for: high-rise physical-furniture and material analog only
- Confidence: medium for Unit 3 applicability; it supports light natural-wood furniture, fixed wood chairs, dark carpet, white built-in storage, and the closet-area mirror/light form, but it is not Unit-3-specific and supplies neither canonical layout nor measurements

### `berkeley_housing_tours`

- Title: UC Berkeley Housing Tours
- URL: https://housing.berkeley.edu/resources/tours/
- Source type: official_video / virtual_tour_reference
- Access date: 2026-07-01 (HTTP 200, live)
- Use for: visual orientation; confirms official "Unit 3 Double Room" and "Unit 3 Triple Room" tours exist (YouVisit + guided videos). Landing page reference only — tour viewer contents must not be opened for asset extraction or scraped.
- Confidence: high for tour availability; supports no dimensions

### `berkeley_residence_hall_virtual_tours`

- Title: UC Berkeley Visitor Services Residence Hall Virtual Tours
- URL: https://visit.berkeley.edu/campus-tours/residence-hall-virtual-tours
- Source type: official virtual-tour landing page
- Access date: 2026-07-01 (live)
- Use for: locating official virtual tours, not copying assets. Page notes in-person residence-hall tours are not offered "to support students' privacy and safety." Does not name Unit 3 specifically.
- Confidence: medium for visual reference availability

### `berkeley_facilities_drawing_request`

- Title: UC Berkeley Facilities Drawing Requests
- URL: https://facilities.berkeley.edu/requesting-campus-building-drawings
- Source type: facilities_drawing request process
- Access date: 2026-07-01 (HTTP 200, live)
- Use for: future exact dimensions and drawing verification (path to `drawing_verified` tier)
- Process facts (2026-07-01): requests go to **maps@berkeley.edu**; a student's **instructor must submit the request** on the student's behalf; the request must include project description, document types, safeguarding measures, and a disposal plan; allow a **minimum of one week**; classified materials require custodian review.
- Confidence: high for process; no dimensions until drawings obtained

### Additional sources (deep-research pass, 2026-07-01 — 24 claims adversarially verified, 3-vote panels)

- **`berkeley_housing_rates`** — https://housing.berkeley.edu/rates-contracts-policies/rates/ — official. Lists Unit 3 room categories: standard Double/Triple (community bathrooms) AND suite Double/Triple (shared bathroom + living area). 2026-27 housing rates: standard Triple $13,840, standard Double $17,000 (housing portion). **No dimensions.**
- **`berkeley_housing_my_room`** — https://housing.berkeley.edu/living-on-campus/my-room/ — official, campus-generic (not Unit-3-specific). Furnishings: "twin XL single beds and/or bunk beds, desks, chairs, and drawer space for each student," plus closets, mirrors, bookshelves, wastebaskets. **No dimensions.**
- **`berkeley_campus_map_unit3`** — https://www.berkeley.edu/map/unit-3-resident-hall/ — official. Names the four Unit 3 towers. **No dimensions, no tours linked.**
- **`pcad_unit3`** — https://pcad.lib.washington.edu/building/21486/ — secondary (architectural archive). Unit 3 = four nine-story towers (Priestley, Norton, Spens-Black, Ida Sproul) + one-story Commons; complex parcel ≈300'×425' (site footprint, NOT room dimensions). Useful context only.
- **`ratemydorm_unit3`** — https://www.ratemydorm.com/reviews/university-of-california-berkeley/university-of-california-berkeley-unit-3 — secondary (student reviews/photos). Verified to contain **no numeric dimensions**. Visual reference only, low confidence.
- **Verified tour/video URLs (visual references only — do not scrape/extract):**
  - YouVisit interactive 3D tour: https://www.youvisit.com/tour/berkeley/143453 (deep link `data-inst=60101&data-loc=143453`)
  - Official "Unit 3 Double Room" video: https://youtu.be/aS5EwS9VjH4
  - Official "Unit 3 Triple Room" video: https://youtu.be/gtpl1WkyRrc
  - UCB Student Affairs "UC Berkeley Housing Tour: Unit 3": https://www.youtube.com/watch?v=6uuLyg-D5_U

## Extracted facts for Unit 3 (original 2026-07-01 pass; double facts re-verified 2026-08-10)

| Fact ID | Fact | Used for | Source ID | Confidence | Dimension status | Notes |
|---|---|---|---|---|---|---|
| u3-triple-room-type | Unit 3 offers double, triple, and limited single rooms; singles are "very few" and typically reserved for students with a documented disability need. | room inventory | berkeley_housing_unit3 | high | not_applicable | Triple is the first MVP room type. |
| u3-room-furniture | Per-resident furnishings: extra-long twin (Twin XL) bed, desk, chair, dresser, mirror, and closet; plus a Microchill refrigerator/microwave combo. | furniture | berkeley_housing_unit3 | high | not_applicable (existence/counts); unknown (dimensions) | Verbatim general Unit 3 furnishing list. The double-specific description additionally places one bookshelf on each side wall and associates a light with each entry-side closet/mirror area. |
| u3-triple-beds-config | In a standard triple, the three sleeping spaces are a bunk bed (two stacked) plus a lofted bed — the page states "triple rooms include a bunk bed & a lofted bed." | layout | berkeley_housing_unit3 | high | unknown | Configuration only; no heights or dimensions may be inferred. |
| u3-double-beds-config | The canonical published double example has one low, non-lofted Twin XL along each side wall, both with their heads at the window wall. | layout | berkeley_housing_unit3 / berkeley_housing_unit3_double_published_3d | high | unknown | This is one official example; rooms vary. Do not import the gallery triple's loft/bunk configuration into the double. |
| u3-double-center-desks | The canonical published double example has two desks arranged tandem/end-to-end on the room centerline, with one accessed from each student's side. | layout | berkeley_housing_unit3 / berkeley_housing_unit3_double_published_3d | high | unknown | The window-side desk is accessed from the left aisle and the entry-side desk from the right aisle. |
| u3-double-entry-storage | A centered inward-swinging door faces a centered window; one closet, mirror, and light sits on each side of the entry. | layout / furniture | berkeley_housing_unit3 / berkeley_housing_unit3_double_published_3d | high | unknown | Relative arrangement only; exact offsets, dimensions, and mounting are unmeasured. |
| u3-double-bookshelves | The official double description states that each side wall has one bookshelf and one Twin XL. | furniture / layout | berkeley_housing_unit3 | high | unknown | Exact bookshelf dimensions and positions along the side walls are not published. |
| u3-double-tour-variant | The official 2020 Unit 3 double tour shows a different valid arrangement with the two desks side-by-side at the window. | variation | berkeley_housing_unit3_double_tour_2020 | high | unknown | Preserve as an explicit variant rather than combining it with the published-3D layout. |
| u3-bathroom | Bathrooms are community bathrooms per floor: one large all-gender bathroom per floor; single-gender floors have single-gender community bathrooms. No in-room bathroom. | layout / warning | berkeley_housing_unit3 | high | not_applicable | Affects room-shell modeling: no bathroom fixture in the room. |
| u3-triple-layout-relative | Official room models/renderings depict one example per room type; usable for relative loft/bunk/desk/closet placement only. | layout | berkeley_housing_unit3 | high | unknown | Do not infer dimensions from images or tours. |
| u3-rooms-vary | "Please note that models depict one example of each room type. Rooms vary in size, layout, and furniture configuration." | warning | berkeley_housing_unit3 | high | not_applicable | Verbatim. Preserve in schema and UI. |
| u3-tour-exists | Official Unit 3 Double Room and Unit 3 Triple Room video/virtual tours exist. | visual reference | berkeley_housing_tours | high | not_applicable | Landing page only; viewers not opened or scraped. |

## Dimensions found

**None — now a rigorously verified negative.** The 2026-07-01 deep-research pass (18 sources fetched, 24 claims surviving 3-vote adversarial verification) confirmed that **each** of these pages states no numeric room/furniture dimension for Unit 3: the Unit 3 housing page, the housing rates page, the housing tours page, the My Room page, the move-in checklist, the visitor-services virtual-tours page, the berkeley.edu campus-map page, and (secondary) RateMyDorm and PCAD. The only number found anywhere is PCAD's ≈300'×425' complex parcel footprint — a site dimension, not a room dimension. Exact `room_shell` fields remain `null` / `unknown`; separate visualization geometry may contain sourced estimates with `estimated: true`. Verification still requires Facilities drawings or authorized measurement.

## Additional verified facts (deep-research pass)

| Fact ID | Fact | Used for | Source ID | Confidence | Dimension status | Notes |
|---|---|---|---|---|---|---|
| u3-room-categories | Unit 3 offers standard rooms (community bathrooms) and suite rooms (shared bathroom + living area) as distinct categories, each in double and triple. | room inventory | berkeley_housing_rates | high | not_applicable | Suite double/triple are future room types for the pipeline. |
| u3-towers | Unit 3 comprises four nine-story towers — Ida Sproul, Norton, Priestley, Spens-Black — plus a one-story Commons building. | building context | berkeley_campus_map_unit3 / pcad_unit3 | high | not_applicable | `building` in room JSONs stays null for representative models; tower names available if models become building-specific. |
| u3-rates-2026 | 2026-27 housing rates: Unit 3 standard Triple $13,840; standard Double $17,000 (housing portion, before meal plan). | student-facing info | berkeley_housing_rates | high | not_applicable | Optional UI metadata; not a modeling fact. |
| ucb-room-furnishings-generic | Campus housing rooms generally include twin XL and/or bunk beds, desks, chairs, drawer space, closets, mirrors, bookshelves, wastebaskets. | furniture (campus-generic) | berkeley_housing_my_room | high | not_applicable | Campus-wide statement. Separately, the Unit 3 page's **double-specific** text explicitly confirms one bookshelf on each side wall; wastebaskets remain campus-generic only. |
| u3-renderings-embedded | The Unit 3 page embeds direct 3D floor-plan and entrance renderings of double and triple rooms (no stated dimensions). | visual reference / relative layout | berkeley_housing_unit3 / berkeley_housing_unit3_double_published_3d | high | not_applicable | The direct double assets were verified live 2026-08-10 and define the canonical representative double variant. |

## Missing exact dimensions

| Missing item | Why needed | Best source |
|---|---|---|
| Room width/depth/height | Required for exact scale | Facilities drawing or authorized measurement |
| Door width/height/position/swing | Needed for accurate shell | Drawing or measurement |
| Window size/position/sill height | Needed for accurate shell and lighting | Drawing or measurement |
| Closet width/depth/height | Built-in geometry | Drawing or measurement |
| Bed/loft/bunk dimensions | Furniture fit planning | Housing spec, vendor spec, or measurement |
| Desk/chair/dresser dimensions | Furniture fit planning | Housing spec, vendor spec, or measurement |
| Microchill dimensions | Fit planning | Housing spec/vendor spec/measurement |
| Mirror size/mounting | Completeness of furnishings | Housing spec or measurement |
| Bookshelf size/position | Complete the side-wall furniture footprint | Housing spec or measurement |
| Closet-area light size/mounting | Complete the entry storage detail | Housing spec or measurement |

## Room variation warnings

Verbatim from the official page (re-verified 2026-08-10):

> "Please note that models depict one example of each room type. Rooms vary in size, layout, and furniture configuration."

Also: "There are very few single rooms, and they are typically reserved for students with a documented disability need."

## Conflicts / uncertainties

- The prior double interpretation was contaminated by the page gallery's image explicitly captioned **"A Triple Room in Units 1-3."** Its lofted-bed, hutch, black rolling-chair, and blue-carpet details are triple/general visual cues and are not double evidence.
- The official sources intentionally show different double examples: the published 3D plan has tandem center desks, while the 2020 Unit 3 tour has two desks at the window. The published 3D example is canonical for this record; the tour is retained as an explicit variation.
- Dresser existence/count and the shared Microchill are official, but their precise placement in the canonical double is not sufficiently supported. Their placement remains uncommitted and is omitted from the 2D plan.

## Modeling implication

The public model is capped at accuracy tier **`official_representative`** and must be labeled:

> Representative Unit 3 room. Layout and furniture are based on official UC Berkeley Housing references (double page and renders verified 2026-08-10). Exact room dimensions are unverified and shown with estimated visualization geometry. Rooms vary in size, layout, and furniture configuration.

## Official gallery photo — triple-only evidence correction (added 2026-07-01; corrected 2026-08-10)

The room photo in the **official UC Berkeley Housing Unit 3 page** gallery is explicitly labeled **"A Triple Room in Units 1-3."** It may be used look-only for that photographed triple/general context, but it must not establish the standard-double layout, furniture profile, or material palette. No image data is copied into the project.

Appearance facts for the photographed triple only (confidence: high that the photo depicts them, not that every double does):

- The photographed triple's furniture is **light natural wood** (blonde maple/oak): bed frames and posts (wood, not metal), desks, drawer units.
- The photographed triple has **black rolling task chairs** (5-spoke caster base, swivel), not wooden four-leg chairs.
- The photographed triple has **blue carpet**.
- Desks sit **under lofted beds** with **shelf hutches** on top (integrated study nook).
- Window is large with a **dark frame**; a **radiator** sits below it.
- The photographed room is a **triple**, not a double; its loft/hutch arrangement must not be imported into the standard-double record.

Layout facts from the official triple depiction (confidence: high):

- **Two desks under the lofted bed**; the **third desk against the exterior (window) wall**.
- **Dresser at the foot of the bunk bed**; closets built into the interior wall near the door entry.

Model impact: these gallery-photo cues may inform the triple only. The double's physical-furniture/material references are the direct published double render plus the official high-rise double analog; the official Unit 3 tour remains a separate window-desk variation. Dimensions remain estimated/unknown and the accuracy tier is unchanged (`official_representative`).

## Private reference archive (added 2026-07-01, night)

A private, look-only research archive was assembled from the public sources linked in this ledger. It includes working copies and analysis notes that are intentionally not distributed with the repository. Reference media must not be republished; model geometry and materials remain original.

Source-specific appearance facts drawn from it (look-only):

- **Double canonical render + official high-rise analog:** low natural-wood Twin XL frames, tandem natural-wood center desks, fixed natural-wood chairs, dark carpet, white built-in entry storage, and closet-area mirrors/lights. The analog is not Unit-3-specific, so material/profile confidence is medium.
- **Triple gallery/reference frames only:** loft/bunk frames, shelf hutches, rolling task chairs, and blue carpet. These facts do not define the standard double.
- **Openings:** the double render and high-rise analog support a centered two-bay exterior-window assembly with radiators below it. The ~2.4 × 1.6 m assembly is a low-confidence 2026-08-10 proportional visualization estimate (two approximately 1.2 m bays), not a value published by Berkeley or by the older model-pack dimension note.
- Official triple floor plan confirms: loft and bunk on opposite side walls, two desks under the loft, third desk at the window wall, closets on the interior wall near entry, dressers at bunk foot and near loft/entry.

### Scope note on hall-specific references (2026-07-01)

The local reference pack also contains hall-specific student-tour thumbnail sets (Ida Sproul corner triple, Priestley triple/double, Norton triple). These depict specific room variants and are **excluded from representative-model comparisons**. The standard double is checked against the direct official double render and high-rise analog; the official gallery photo is triple-only evidence, and the Unit 3 tour is a separate window-desk variation.

## Room proportions — near-square (added 2026-07-02)

| Fact ID | Fact | Used for | Source ID | Confidence | Dimension status | Notes |
|---|---|---|---|---|---|---|
| u3-room-aspect-square | The official Unit 3 3D room views (top-down floor plans of the double and triple, embedded on the official housing page) depict a **near-square room**, with the window wall slightly longer than the entry-to-window depth. Pixel-measured aspect from the two official top views: W:D ≈ 1.03 (double) to ~1.1 (triple). | room-shell placeholder proportions | berkeley_housing_unit3 | medium | estimated (aspect only, no absolute size) | Re-checked against the live housing page 2026-07-01. Ratio only — no absolute dimension may be inferred. |

Model impact: the generator's visualization placeholder was corrected from the old elongated 3.35 × 4.88 m rectangle (aspect 0.69 — unsupported by any official depiction) to **4.35 × 4.15 m** (aspect ~1.05, interior ≈ 17.4 m²). Both values remain `estimated: true` placeholders; `room_shell` dimensions stay `null` and the accuracy tier stays `official_representative`.

## Interior model pack — full layout + dimension estimates (added 2026-07-02)

**Source ID: `unit3_interior_model_pack_2026_07`** — private look-only analysis pack assembled from the public UC Berkeley and YouTube sources linked in this ledger. It contains working reference frames, labels, manifests, and estimates anchored to official layout text plus Twin XL furniture scale. The pack is not distributed; no reference image data is copied or shipped, and model geometry/materials remain original.

Layout facts (confidence noted per room; sources are kept separate rather than blended):

- **Both rooms**: window wall is the LONG wall; entry↔window is the SHORT axis. One wide window, centered; curtains hang bunched at the window's ends; dark-finned radiator below the window.
- **Triple**: door at the **upper-left corner** of the entry (interior) wall; **two closets built into the entry wall right of the door** (modules read as wardrobe + open shelf column); **loft along the left side wall and bunk along the right side wall, both bed heads at the window wall** (official photo shows heads tight to the window); two desks under the loft; **third desk against the window wall facing the window**; a low drawer unit at the window wall right of center (official photo); dresser at the foot of the bunk. The official view also places a dresser near the loft's foot/door corner — that spot conflicts with a 0.9 m door swing at our estimated envelope, so the model puts dresser_1 on the entry wall right of the closets (drawers opening into the room, near the bunk-foot corner). As of the 2026-07-02 scale review the enlarged shell (and the loft ladder moving to the bed's side, like the bunk's) makes the official loft-foot corner swing-legal, so dresser_2 now sits THERE — the deviation is resolved; the generator still clamps that spot against the 0.9 m swing zone. The window-wall drawer unit was removed from the model because it read as clutter in front of the window. The Microchill takes the right wall's entry band; the triple's bookshelves are the under-loft desk hutches (official photo), so no separate shelf column is modeled there.
- **Double canonical published-3D example (high):** door **centered** on the entry wall and swinging inward toward a centered window; one closet/mirror/light on each side of the entry; one bookshelf and low Twin XL along each side wall, with bed heads at the window; **two desks in a tandem/end-to-end run on the centerline**, with the window-side desk accessed from the left aisle and the entry-side desk from the right aisle. Dresser and Microchill placement are **uncommitted** because the official text does not locate them clearly.
- **Double official-tour variation (high for that room):** two desks sit side-by-side at the window. This is recorded as a separate valid variant and is not blended into the canonical plan.

Dimension estimates (confidence: medium — pack's modeling doc; **not** official measurements; all `estimated: true`):

| Item | Estimate (m) | Basis |
|---|---|---|
| Room interior | **4.115 W × 3.505 D × 2.44 H** (13.5 × 11.5 × 8 ft, ±0.3) | official layout views + Twin XL scale; supersedes the 2026-07-02 "near-square 4.35×4.15" pixel-aspect note (that reading misassigned the axes; the official views measure W:D ≈ 1.17 with beds along the depth axis) |
| Bed footprint | 2.083 × 1.016 | Twin XL + frame allowance |
| Desk | 1.067 × 0.61 × 0.762 | visual scale |
| Dresser | 0.762 × 0.61 × 0.762 | visual scale |
| Closet module | 0.914 × 0.61 × 1.981 | visual scale |
| Microchill | 0.508 × 0.508 × 1.118 | visual scale |
| Door leaf | 0.914 × 2.032 | standard + visual |
| Two-bay window assembly | ~2.4 W × 1.6 H, low confidence | 2026-08-10 internal proportional interpretation of the direct double render/high-rise analog; the full assembly is treated as two approximately 1.2 m bays. This is not a Berkeley measurement, and it deliberately does not attribute the number to the older pack's smaller single-opening recommendation. |

Model impact at this research stage: the 4.115 × 3.505 × 2.44 estimate and table above remain useful for the standard double; exact `room_shell` dimensions stay `null`, every visualization dimension stays estimated, and the accuracy tier stays `official_representative`.

### Envelope re-estimate — pixel measurement + visual scale review (2026-07-02, later)

Pixel-measuring the official top-down views against the Twin XL bed frame (2.083 m known length) gives interior ≈ **4.2 × 3.6 m ± ~5%** (bed spans 388/670 px of the depth axis and 160/658 px of the width axis in the triple view). No official square footage exists anywhere (re-searched 2026-07-02: housing pages, campus map, student sites — verified-negative stands). A visual review found the previous 4.115 × 3.505 estimate cramped against the real-size furniture, so the placeholder moved to the TOP of the honest band: **4.45 × 3.85 × 2.55 m** (≈14.6 × 12.6 × 8.4 ft, ~17.1 m² interior) — within the pixel-measure error plus the pack's ±0.3 m tolerance. Still `estimated: true`; `room_shell` stays `null`; the model reads "roomier" only within the documented uncertainty. This paragraph records a historical modeling round; the 2026-08-10 reconciliation below supersedes its blended double desk/detail interpretation.

### Envelope note — round 9 (2026-07-02, visual scale review continued)

The shell still appeared tight at 4.45 × 3.85 when real-size furniture was compared with the official renders' petite furniture. The estimate moved to the FAR edge of the honest envelope: **4.60 × 3.95 × 2.60 m** (~15.1 × 13.0 × 8.5 ft, ~18.2 m² interior) — the pixel measurement (~4.2 × 3.6) carries up to ~10% reading error on the oblique low-res official renders, and the pack's ±0.3 m tolerance stacks on top. This was a historical shared-room estimate; the 2026-08-10 reconciliation below supersedes it for the standard double. Exact `room_shell` stays `null`/`unknown`.

## Standard-double canonical reconciliation — 2026-08-10

- The live Unit 3 page and direct double assets were rechecked. Berkeley's published 3D example is now the canonical variant for `unit-3-standard-double`; the official 2020 Unit 3 tour is retained as a distinct window-desk variation.
- The canonical plan uses the page's relative facts: centered inward-swinging door opposite a centered window; entry-side closet/mirror/light pairs; one bookshelf and low Twin XL per side wall; and two tandem/end-to-end center desks accessed from opposite student aisles.
- The double `visualization_shell` returns to the pack's center estimate, **4.115 × 3.505 × 2.44 m**, with medium confidence and explicit non-measurement wording. The later 4.60 × 3.95 × 2.60 far-edge estimate remains the triple's visualization shell only. The double's exact `room_shell` remains `null`/`unknown`.
- Dresser existence/count and the shared Microchill remain in the data, but their placement is uncommitted and omitted from the canonical 2D plan. Bookshelf/mirror/light footprints are likewise omitted until dimensions and precise positions are supportable.
- The official gallery image captioned "A Triple Room in Units 1-3" is explicitly excluded from double layout, furniture-profile, and material claims. Double physical-detail cues come from the direct double render and the official high-rise double analog.
