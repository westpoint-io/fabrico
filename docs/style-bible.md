# Fabrico Style Bible

> **STATUS: LOCKED.**
> **Machine art direction - "Direction A, blueprint continuation", locked 2026-07-31**
> (Phase 57, BOARD-01/02/03), at a **belt lane width of 20 px**. Every value in sections 1, 2, 3,
> 5 and 7 below is a transcription of a cell in
> the art-direction record (`57-ART-LOCK.md`). Not one of them is authored
> here, measured here, or derived from how anything looked. **That lock is the only source this
> document draws from, and where it is silent this document says so instead of filling the gap.**
> **Palette - "Clean Slate", locked 2026-07-06** (Phase 24). The five-step ramp and the
> five accent roles in section 1 are that earlier lock, carried unchanged: the art lock addresses
> ink ASSIGNMENT (which ramp index paints which part) and never ramp VALUES. The executable form
> is `frontend/src/render/synth/skins/locked.ts` (`LOCKED_SKIN`); that literal and section 1 are
> two views of ONE locked truth and must agree.
> **Belt line direction - "Direction B, blueprint / clean line", locked 2026-07-26**
> (Phase 53, `53-BELT-LOCK.md`), recorded in section 4. Phase 57 reopened none of it and locked
> exactly one belt number: the lane width, in section 2.
> Changing any of the three is a re-lock decision for the maintainer, not an incremental edit.

This is the single art-direction source of truth. The vector art phases (58 machine art, 59
chrome, 61 belt geometry) consume ONLY this bible and the locked skin - never a draft, never a
candidate from the art board, never the retired style board.

**What replaced what, on 2026-07-31.** Sections 1, 2, 3, 5 and 7 were v4.0 pixel-era content
describing a baked `PixelMatrix` pipeline that milestone v7.0 is removing. They are now the
vector-era rules, derived cell by cell from the art lock. **Sections 4 and 6 were CARRIED
unchanged, and the reason is recorded rather than glossed:** both are anchored BY SECTION NUMBER
from shipped source (`frontend/src/render/faultBlink.ts:1`, `faultBlink.test.ts:4`,
`interp.ts:27` name section 4; `frontend/src/render/synth/chrome/skinToCssVars.ts:6` names
section 6), and the art lock has nine axes of which motion is none and chrome is none. Replacing
them would either break a live reference or fill them from something other than the lock, and
the second is the one thing this document is forbidden to do. Each carries its own banner below.

---

## 1. Palette + Ink Assignment

### 1a. The ramp (carried from the Phase 24 "Clean Slate" lock, unchanged)

The ramp is an ordered array of `0xRRGGBB` steps, darkest (index 0) to lightest (last),
length >= 3. **A vector asset names a ramp INDEX and never a hand-authored hex** - that is the
legal range printed on the art lock's axis 3 and axis 7, and it is what makes a per-part retint
possible without touching artwork.

**Locked ramp (Clean Slate, 5 steps):**

| Index | Hex        | Role in the vector era | Where it appears |
|-------|------------|------------------------|------------------|
| 0     | `#1b1f27`  | substrate              | the board/canvas ground the art sits on |
| 1     | `#2a2f3a`  | body-shadow            | not consumed by machine art under this lock (it is Direction B's and C's outline ink, and both are refused) |
| 2     | `#3b4250`  | body (fill)            | panel body fill; not consumed by machine art under this lock (axis 6 ceiling 1, and no chassis fill exists) |
| 3     | `#565f70`  | panel / highlight      | raised panel face; the fill value Directions B and C used for chassis and badge, both refused |
| 4     | `#b0bacb`  | **structural ink**     | **every machine outline and every glyph under this lock** (art lock axis 3, axis 9); 5.16:1 on the `#3b4250` fill, WCAG AA normal PASS |

**Accent roles - one semantic job each, reserved usage (never reused for chrome):**

| Role      | Hex        | Reserved usage |
|-----------|------------|----------------|
| `working` | `#34d399`  | active/producing machine state only |
| `fault`   | `#f0506e`  | fault state, alert ring, error signaling only |
| `item`    | `#ffb454`  | item dots riding belts only |
| `build`   | `#4fa8ff`  | build/ghost/selection-affordance accents only |
| `electric`| `#4ee0ff`  | electrical-wire energy only (the wire terminals and the request spark); the canonical energized/high-voltage read, distinct from `build` `#4fa8ff`. The resting cable body is NOT this accent: it is `palette.cable` (section 1d) |

### 1b. Ink assignment under the art lock

| Rule | Value | Lock cell |
|---|---|---|
| Structural outline ink | **`ramp[4]` `#b0bacb`** | axis 3, outline ink |
| Kind-family colour encoding | **none - one ink (`ramp[4]`) for every kind** | axis 9, encoding scheme |
| How many families are drawn | **1** - no family split drawn | axis 9 |
| What carries the family, structurally | **nothing does.** There is no chassis fill under this lock, so a family encoding has nowhere structural to live and would have to move onto the outline ink or onto a part that does not exist yet | axis 9 |
| Hand-authored hex in an asset | forbidden. Ink is a ramp index | axis 3 legal range, axis 7 legal range |

**ART-02 opens on the row above and this document does not close it.** ART-02 requires machine
kind encoded by chassis-fill hue in families, and the locked direction carries no chassis fill.
The scheme is the lock's axis 9; the hue VALUES are Phase 58's business and are deliberately
absent here, because ART-03's colour-vision gate has to be satisfied before any hue is pinned.

**There is no lighting section in the vector era.** The retired v4.0 sections 1-2 described a
shallow 1 px bevel from a fixed top-left light, realized as `bakeRamp` index selection. Under
this lock **axis 7 pins the shadow at offset 0**, so there is no bevel, no offset shadow, no
blur, no gradient and no second light on any machine asset - see section 2f. `bakeRamp`'s
bevel roles remain the business of the pixel path until VEC-01 removes the last `PixelMatrix`
from the canvas in Phase 61.

### 1c. Label palette (phase 76, D-05)

A label is a note on the board, not a machine, so it carries no state and is never tinted by
a state accent. It takes one of six colours from a CLOSED set, in this byte order (the Rust
`LabelColour` order and the TypeScript `LABEL_COLOURS` order, locked together by
`crates/fabrico-command/tests/ts_label_mirror.rs`). The live values are
`render/synth/skins/locked.ts` `palette.labels`, and this table must agree with them. They are
ADDITIVE: no ramp or accent value moved to make room.

| Byte | Name | Hex | Outline on ground | Words (`--fab-ink`) on the fill |
|------|------|-----|-------------------|----------------------------------|
| 0 | Sand (a new label's colour) | `#e0d388` | 10.88 : 1 | 5.69 : 1 |
| 1 | Stone | `#a19d95` | 6.11 : 1 | 6.47 : 1 |
| 2 | Moss | `#a3c27f` | 8.32 : 1 | 6.07 : 1 |
| 3 | Lilac | `#bea2ea` | 7.51 : 1 | 6.20 : 1 |
| 4 | Rose | `#e39ac0` | 7.59 : 1 | 6.20 : 1 |
| 5 | Clay | `#d68c6c` | 6.15 : 1 | 6.53 : 1 |

Ratios are WCAG relative-luminance contrast; "the fill" is the colour at alpha 0.16 over
`ramp[0]` `#1b1f27`. Every outline clears 3 : 1 (non-text contrast) by double, and every fill
keeps the words above 4.5 : 1 (body text AA). The box is the label colour at alpha 0.16, outlined
in the same colour at alpha 1 and 2 world px (never under one screen pixel), inset 4 world px on
the centreline exactly where a machine chassis sits. It is the ONLY filled rectangle on the
board, because every machine is an open outline (lock axis 3), and that fill is what tells a
note from a machine. The set is muted on purpose: a label is context, never the brightest thing
on the board. These six were judged on the phase 76 walk; the maintainer can overturn them.

### 1d. Cable (phase 92, D-10)

The resting cable between two electrical ports is one colour, stroked at alpha 1 at every zoom,
2 world px wide (never under one screen pixel). The live value is `render/synth/skins/locked.ts`
`palette.cable`, and this row must agree with it. It is ADDITIVE: no ramp or accent value moved to
make room. Canvas only, no CSS variable: the Legend's Wire swatch reads the same token.

| Token | Hex | On the floor `#1b1f27` | On a minor line `#2a2f3a` | On a major line `#3b4250` |
|-------|-----|------------------------|---------------------------|---------------------------|
| `palette.cable` | `#2e8f99` | 4.33 : 1 | 3.52 : 1 | 2.65 : 1 |

Ratios are WCAG relative-luminance contrast. Until phase 92 the cable was `ramp[3]` `#565f70` at
alpha 0.35, which composited to a dimmer copy of the grid's own grey (1.35 : 1 on the floor and
1.22 : 1 against a major line), and walk-114 read the cables as stray rectangle outlines. A brighter
grey was rejected because it would read as a machine outline. The teal is neither `electric` (the
terminals and the request spark ride the cable) nor `build` (the re-route mark is stroked over it),
and it is told from the fault red, at nearly the same lightness (1.10 : 1), by hue and by shape: a
cable never runs inside a machine's box. Judged on the walk at the 1.18 text scale; the maintainer can
overturn it.

---

## 2. Authoring Grid, Strokes and Geometry

Every number in this section is a cell of the art lock's section 2, section 2.10 or section 3.
Where a legal range is printed, it is the range the shipped validators enforce -
`frontend/scripts/lint-svg.ts` (twelve rules, run at `fail` severity over the candidate set) and
`frontend/src/render/svgAssets.ts` (`measureSvg` / `classifyVertexCount`, the 400-vertex budget).

### 2a. The grid (lock axis 1)

| Rule | Locked value |
|---|---|
| Authoring unit | **32 units per cell**, across the whitelisted footprint set. Never 32u for a whole 3x3 machine. |
| Legal `viewBox` set | the **closed four-value whitelist**, compared by **exact string equality**: `0 0 32 32` (1x1), `0 0 64 64` (2x2), `0 0 64 96` (2x3), `0 0 96 96` (3x3). Not a regex and not a divisibility test - `0 0 96 64` is a transposed router and must fail. |
| Coordinate form | **integers only**, in the `d` attribute. Enforced at `fail` severity by the `integer-coords` lint rule. |

The whitelist is closed for the Phase 57 base footprints. `grow_to_fit` (PORT-07) reopens it for
any later phase authoring art at a grown footprint, and reopening it is a deliberate edit to
`LEGAL_VIEWBOXES`, never a loosened comparison.

### 2b. The stroke system (lock axis 2)

| Rule | Locked value |
|---|---|
| Structural stroke | **3u** |
| Detail stroke | **2u** |
| Any third weight | **none.** Only 2u and 3u appear. A third weight is a new value on this axis and has to be stated as one. |

### 2c. The corner-radius policy (lock axis 5)

| Rule | Locked value |
|---|---|
| Radius, in u | **0 - square** |
| Authored as | **square**: neither an arc nor a chamfer |
| Curve commands in the set | **0** |

**Why 0 is load-bearing rather than incidental.** Pixi's `buildAdaptiveBezier` hardcodes
`const scale = 1` and caches the tessellation on the shared context, so **any authored arc serves
stale geometry on zoom** - visibly faceted at the 1.77x and 2x levels the art board exists to
judge. The measured cost of a radius, recorded against the day one is proposed, stated in ONE unit:
TOTALS for a single stroked closed **`<path>`** outline whose corners are authored as `A` arc
commands, at `stroke-width: 3` with `fill="none"` on `0 0 32 32`, measured through `measureSvg`
(Pixi's own tessellation path), with the delta against a square corner beside each. **The authoring
form is part of the measurement, not a detail of it** - see the re-measurement block below the
table.

| Corner treatment | Stroked outline, `sw=3` | vs square | Filled path | vs square |
|---|---|---|---|---|
| square, 4 corners | **24 verts** / 12 pts | - | **8 verts** / 4 pts | - |
| chamfer, 8 corners | **40 verts** / 20 pts | **+16** | **16 verts** / 8 pts | **+8** |
| 2u arc | **80 verts** / 40 pts | +56 | n/a | n/a |
| 12u-or-larger arc | **168 verts** / 84 pts | +144 | n/a | n/a |

**Re-measure it: the exact `d` of every row above.** Each is one closed subpath on `0 0 32 32`,
measured as `<path d="..." fill="none" stroke="#000" stroke-width="3"/>` for the stroked column and
as `<path d="..." fill="#000"/>` for the filled column.

| Row | `d` |
|---|---|
| square | `M 0,0 H 32 V 32 H 0 Z` |
| chamfer (4u cut) | `M 4,0 H 28 L 32,4 V 28 L 28,32 H 4 L 0,28 V 4 Z` |
| 2u arc | `M 2,0 H 30 A 2 2 0 0 1 32,2 V 30 A 2 2 0 0 1 30,32 H 2 A 2 2 0 0 1 0,30 V 2 A 2 2 0 0 1 2,0 Z` |
| 12u arc | `M 12,0 H 20 A 12 12 0 0 1 32,12 V 20 A 12 12 0 0 1 20,32 H 12 A 12 12 0 0 1 0,20 V 12 A 12 12 0 0 1 12,0 Z` |

**The same shape authored as `<rect rx="N">` is DEARER, and this is the trap.** Pixi's SVG parser
routes `<rect rx>` through `roundRect`, which approximates a corner with a different point count
from the `arcToSvg` an `A` command reaches. Re-measured through the identical path: `<rect rx="2">`
at `sw=3` is **104 verts / 52 pts** (not 80) and `<rect rx="12">` is **216 verts / 108 pts** (not
168) - 30% over the figures in the table. A plain `<rect>` with no `rx` measures **24 / 12**, the
same as the square path, so only the two arc rows are keyed to the authoring form. Every one of the
218 shapes across the 32 art-board candidates is a `<path>`; not one is a `<rect>` and not one
carries an `rx`, which is why the table is stated in the form the candidates are actually drawn in.
Budget 80 for a 2u corner authored as `<rect rx="2">` and the real spend is 104, against a
400-vertex cliff this bible calls silent.

**A chamfer is NOT free in vertices.** It adds four path points, which section 2d's per-primitive
model prices at +16 on a stroke and +8 on a fill - and the model and the measurement agree exactly.
A chamfer is far cheaper than any arc and it is immune to the stale-tessellation hazard, and it is
still not what is locked. The 2u arc is sub-pixel at every zoom the board showed; the 12u-or-larger
arc is faceted at 2x. Under this lock none of the arc costs is incurred, because no asset carries a
curve.

The `curve` lint rule stays at `warn` severity. This lock does not raise it to `fail`: that is a
change to a shipped gate and Phase 58 owns whether to make it.

### 2d. The fill-count ceiling (lock axis 6)

| Rule | Locked value |
|---|---|
| Distinct filled paths per asset | **1 - a MAXIMUM**, asserted as a ceiling an asset may not exceed, never a target to reach. |

Under the locked direction three subjects (`router`, `sink`, `source`) carry one filled path and
the other five carry none, so the ceiling of 1 is at or above the direction's own fill count -
which is the joint constraint the lock prints at its axis 6. A ceiling below the direction's own
construction is a contradiction rather than a constraint.

**A low fill ceiling makes assets DEARER, not cheaper**, and this is measured rather than
asserted: **a stroke costs 4 vertices per point and a fill costs 2**, so a filled rectangle costs
**8 vertices** while its stroked outline costs more. The whole 32-candidate art board spanned
**60 to 166 vertices against the 400-vertex ceiling**; the locked direction totals **604 vertices
/ 302 points across its eight subjects**. The full per-primitive cost model and where each figure
was measured are in the art lock's own Provenance table - this document carries the figures the
lock carries and does not restate a measurement the lock does not hold.

**The 400-vertex cliff is silent.** `batchMode: 'auto'` sets `isBatchable = vertices.length < 400`,
so an asset that crosses it stops batching without an error. The dev assertion that catches it
ships alongside the assets.

### 2e. The detail floor (lock axis 8)

| Rule | Locked value |
|---|---|
| Minimum detail stroke | **2u** |
| Curve detail below the floor | **forbidden.** 0 curves are authored anywhere. |
| How a curved motif is expressed instead | a **straight-edged diamond** stands in for a curved almond (`source`); **square rings** stand in for circular ones (`sink`). |

This is the rule that keeps shipped assets curve-light for VEC-03, a requirement already Complete
that this lock does not undo.

### 2f. The shadow (lock axis 7)

| Rule | Locked value |
|---|---|
| Offset, in u | **0 - no shadow** |
| Ramp step | n/a at offset 0 |
| On which parts | **none** |

BOARD-02 names a **single hard offset** shadow - never a blur, never a gradient, never a second
light - and this lock pins that single offset at **0**. What is locked here is the ABSENCE of a
shadow: not one of the 32 board candidates carried one, so this is the one axis stated on its own
rather than judged against four drawn options, and the art lock records that limit at its section
5 ceiling 7. **A shadow in Phase 58 is a new value on this axis and has to be stated as one**,
against art drawn in the locked direction.

### 2g. The belt lane width (BOARD-03, lock section 3)

| Rule | Locked value |
|---|---|
| Belt lane width | **20 px. Stated by the maintainer, 2026-07-31.** |

The derived figures, transcribed from the lock's section 3. Every one is computed from the lane
width and the elbow radius; not one is a free number.

| Derived figure | Value | Derived from |
|---|---|---|
| `laneHalf` | 10 | `lane / 2` |
| inner radius `r_in` | 6 | `R - laneHalf` |
| **inner-rail dash** | **3.750 px** | `DASH * r_in / R` = `10 * 6 / 16`, at Direction B's locked 10/6 centreline dash |
| outer radius `r_out` | 26 | `R + laneHalf` |
| outer-rail dash | 16.250 px | `10 * 26 / 16` |
| outer : inner | 4.33x | `16.250 / 3.750` |
| inner : lane | 0.300 | `6 / 20` |
| joint margin `R - laneHalf` | +6 | clears `53-BELT-LOCK.md` axis 3's `rail < laneHalf <= elbowR` guard |
| corner pinch | 0 px | definitional under the corrected geometry: the swept corner lane has constant width by construction |

**Which of the nine are DRAWN, and which were SELECTION criteria (added 2026-08-11, plan 61-08, so the next reader does not re-derive the inner-rail-dash question a third time):** `laneHalf`, `r_in`, `r_out`, `inner : lane` and `corner pinch` are drawn properties of the shipped belt and are gated as such, while **inner-rail dash, outer-rail dash and `outer : inner` are lane-width SELECTION criteria that did their job at the art board and are NOT drawn at all** - the locked tread is a 2 px dash on the lane CENTRELINE over SOLID rail arcs (`53-BELT-LOCK` axes 1 and 2), so no dashed element exists at either rail to measure, and their measurable restatement is the drawn dash's own arc length across its 2 px band, 9.375 px at `r` = 15 to 10.625 px at `r` = 17 (`61-UI-SPEC.md` A5).

**THE `R = 16` DEPENDENCY, stated as a dependency.** The nine figures above assume
`ELBOW_R = 16`. **The shipped tree carries `ELBOW_R = 15`** (`frontend/shared/geometry.ts`), and
16 is SEED-012's **unsigned** supersession of `53-BELT-LOCK.md` axis 3 - the maintainer's own signed lock.
It lands, or does not land, in Phase 61.

- The **`20 px` is unconditional**: the maintainer stated a width, not a radius, and was not asked to
  sign SEED-012 at the Phase 57 gate.
- The **nine derived figures are conditional**. At `R = 15` the same 20 px lane gives an inner
  radius of 5 and an inner-rail dash of **3.333 px** rather than 3.750. A Phase 61 refusal of
  SEED-012 therefore **invalidates** this block and it is re-derived at 15 in a new lock entry
  that names the old one. The figures never move silently under a width already stated.
- **Neither number is in the shipped tree yet.** Phase 57 edited no source. Adopting `20` or `16`
  into `frontend/shared/geometry.ts` is Phase 61's work and it needs the maintainer's signature on the
  written supersession.

### 2h. The fixed-light rule

> Kept in section 2 because shipped source names it by section number:
> `frontend/src/render/synth/generators.ts:949` calls the belt bake "the style-bible section 2
> fixed-light rule expressed in the bake". The rule below is sourced from the two locks that hold
> it, never restated from how anything looks.

**The light direction is a fixed constant, and no asset may carry a per-tile light.** Two locked
cells produce it from opposite ends:

- **Machines (art lock axis 7): offset 0.** No shadow, no bevel, no gradient and no second light,
  so a machine asset carries no lighting at all and there is no direction to flip. See section 2f.
- **Belts (`53-BELT-LOCK.md` axis 2): both rails on the SAME ramp step, symmetric about the flow
  axis.** This is a hard constraint rather than a per-direction choice: a lit lip or a bevelled
  rail breaks a fixed light source under 90-degree tile rotation, which is what makes the corner
  bake's counter-clockwise x-mirror safe. It is the mistake Factorio had to undo when it removed
  belt sprite mirroring (FFF-269).

The consequence for the shipped pipeline: **shading is a choice of ramp index, never a computed
tint**, so the same skin in produces byte-equal output out - a determinism requirement rather than
a stylistic one, and the reason section 7 forbids a brightness-multiply anywhere in the asset path.

---

## 3. Chassis, Silhouette and the Kind Vocabulary

### 3a. Chassis construction (lock axis 3)

| Rule | Locked value |
|---|---|
| Construction | **open chassis, no chassis fill** |
| Outline weight | **3u** (this is axis 2's structural stroke, echoed) |
| Outline role | **the outline IS the structure** - not a border around a fill |
| Outline ink | **`ramp[4]` `#b0bacb`** |

The art lock's axis 3 carries a joint constraint - `outline ink step != chassis fill step`,
because an outline and a fill on the same ramp step read as one flat shape and nothing in the
pipeline throws when they do. Under this lock it is satisfied vacuously: **there is no chassis
fill for the outline step to collide with.** It becomes live again the moment anyone proposes a
fill, and there is no validator behind it - it is held by reading the rule.

### 3b. Silhouette strategy (lock axis 4)

| Rule | Locked value |
|---|---|
| Strategy | **shared outline, per-kind glyph** |
| What carries kind with colour removed | **the glyph** |
| The `MERGE` / `BALANCER` pair | **EXPOSED.** Both are the same 4u-inset rectangle; only the 2u interior glyph separates them. |

**The exposed pair is an OPEN item handed to Phase 58, not a solved one.** ART-01 requires every
silhouette identifiable in pure greyscale and ART-03 runs the colour-vision gate over the shipped
set; both land on this pair. The one drawn alternative that could not collapse - a per-kind
outline SHAPE - belonged to a refused direction. Whether the locked glyphs hold under greyscale
and the three CVD channels is a judgement no machine result in Phase 57 made, and this document
does not make it either.

### 3c. The per-kind semantic vocabulary (lock section 2.10)

**8 of 8 carried.** Nothing in the shipped `synth/glyphs.ts` motif vocabulary is consciously
rejected under this lock. Silently losing a motif in the redraw is the failure mode this table
exists to prevent.

| Subject | Semantic motif | Carried into vector as |
|---------|----------------|------------------------|
| `SOURCE`   | spawn eye        | carried; a straight-edged diamond stands in for the curved almond (detail floor, section 2e) |
| `SINK`     | bullseye         | carried; square rings stand in for circular ones |
| `ENDPOINT` | *(none to inherit)* | the shipped wire-terminal inlet reading is carried instead - the shipped endpoint has no generator, so there is no prior motif |
| `TEE`      | fork             | carried |
| `BALANCER` | twin bars        | carried |
| `MERGE`    | funnel           | carried |
| `ROUTER`   | decision diamond | carried |
| `FACTORY`  | code braces `{ }`| carried |

`BELT` appears in no row above and in no axis of the art lock. Belt art is locked separately by
`53-BELT-LOCK.md` (section 4 below), and Phase 57 touched exactly one belt number: the lane width.

### 3d. Provenance (ART-04, lock section 2.10)

| Rule | Locked value |
|---|---|
| Licence provenance | **authored from scratch.** No icon pack consulted, copied, traced or redrawn. |
| Excluded outright | **game-icons.net** (CC-BY-3.0, which redrawing does not clear) and **Remix Icon** (non-OSI, bans icon-pack redistribution). Art that cannot ship is not art direction. |

**Provenance is authored WITH the asset, never reconstructed afterwards**, because provenance
reconstructed after the fact is not provenance. Each asset's own file header carries it, and a
gate asserts that each header names its own path and its own directory - an assertion that exists
because a copy-paste between directories once survived review.

---

## 4. Motion Timing Table

> **CARRIED UNCHANGED from the v4.0 lock, deliberately.** This section is anchored by section
> NUMBER from three shipped source files (`frontend/src/render/faultBlink.ts:1`,
> `frontend/src/render/faultBlink.test.ts:4`, `frontend/src/render/interp.ts:27`), and **motion
> is none of the art lock's nine axes** - the maintainer was not asked about it and stated nothing about it.
> Rewriting it would mean sourcing it from something other than the lock, which this document is
> forbidden to do. The timing numbers below are a live contract and stay.

> **THE PHASE 61 HANDOFF IS DISCHARGED, 2026-08-11 (plan 61-08).** This banner used to carry an
> open item: *"Its remaining bake-and-sprite MECHANICS describe the pixel path that VEC-01 removes
> in Phase 61; that phase owns restating them, from its own locked values. Recorded here as an
> open item rather than quietly rewritten."* Phase 61 has run. The mechanics are restated below
> under **Bake-and-sprite mechanics, restated for the vector path**, the fault-overlay sentence is
> corrected in place, and the belt paragraph that closes this section is amended where Phase 53
> declined to amend it. **No timing number moved and no locked value moved**: the table below,
> the fault-blink envelope and the three source anchors are exactly as they were. What changed is
> the description of HOW those timings are drawn, which was describing a pixel path the tree no
> longer walks.

This phase OWNS these numbers; Phase 26 IMPLEMENTS them. Timings are grounded in
what the live board's quantized ticker actually showed (`FPS = 10`, bounded
`FRAMES = 24` cycle - see 24-03-SUMMARY.md), inside the 8-12fps band.

| State    | Frame rate | Cycle | Behavior |
|----------|------------|-------|----------|
| idle     | 0 fps (static) | none | no re-bake; a single resting frame, zero ticker cost |
| working  | 10 fps quantized | 24-frame bounded loop | advances only working sprites + item positions; caches saturate, never grow |
| faulted  | 10 fps quantized | 24-frame bounded loop (2.4s) | asymmetric alarm blink on the alert ring's `alpha` (see below); steady fault trim always on |

**Fault-blink cadence (MOTION-03, authored Phase 26).** The FAULTED cue is two
layers: a **steady fault trim** on the body (a fault-accent top-edge bar +
corner marker - the always-on colour + shape floor, VIS-03 colour-blind
redundancy) and a **board-drawn alert ring** whose `alpha` is
modulated per frame. (That second layer read *"a separately baked fault-marker overlay
sprite"* until 2026-08-11; see the correction in the bullet list below - the CADENCE is
unchanged, the surface it tints is not a bake.) The alert alpha is a deliberate ASYMMETRIC alarm envelope
(never a symmetric sine "breathe"), a pure function of the pinned sim-frame clock
(`frontend/src/render/faultBlink.ts`, `faultBlinkAlpha`):

| Segment | Frames | Duration @10fps | Alpha |
|---------|--------|-----------------|-------|
| fast attack  | 0..3   | 0.3s | 0.25 -> 0.80 (linear rise) |
| slow release | 3..14  | 1.1s | 0.80 -> 0.25 (linear decay) |
| hold at floor| 14..24 | 1.0s | 0.25 (rest) |

- **Peak alpha cap = 0.80** (never 1.0): an accent pulse, not a strobe or a
  keyframe flash. **Floor = 0.25** (never 0.0): the overlay never fully vanishes,
  and the steady baked trim keeps colour + shape legible at the trough and on any
  paused/frozen frame.
- **Attack (3f) < release (11f)** is the hard asymmetry invariant - the alarm snaps
  ON and eases OFF.
- **Per-node phase desync:** each fault's `localFrame = (frame + phaseOffset(cellX,
  cellY)) % 24`, where `phaseOffset` is an inline FNV-1a hash of the STABLE origin
  cell (never `node.id`, which re-mints on keyframes). Adjacent faults blink out of
  phase, so a grid full of faults never reads as one synchronized pulse; phase
  survives undo/redo/load.
- **Paused holds steady:** the alert ring reads the pinned frame clock, so when the sim
  pauses the frame freezes and the alpha holds - no paused-specific code. The one
  alarm that keeps MOVING while paused is the stranded-dock ring, not the fault
  blink. (Its parenthetical used to read *"(board-drawn Graphics)"*, which distinguished
  it from a baked fault overlay. Both are board-drawn Graphics now, so the distinction
  that carries the claim is liveness while paused, not the surface.)
- **The blink is alpha compositing, never a synth byte-multiply** (section 7 holds) and
  never a per-frame re-plot (MOTION-05 holds): ONE display object whose `alpha` varies.
  **CORRECTED IN PLACE, 2026-08-11 (plan 61-08), rather than deleted.** The sentence read:
  *"a single overlay texture, baked once per (kind|skin), composited at a varying alpha."*
  There is no baked overlay texture any more. Plan 58-03 moved the fault marker's job to
  the **board-drawn alert ring**, and plan 61-07 deleted the orphaned per-kind
  fault-overlay bake and its set builder outright on a re-run grep that found zero
  render-path callers. The CADENCE is unchanged and still single-sourced: the ring reads
  `alertRingAlpha` (`render/layers/machineState.ts`), which is a one-line reuse of
  `faultBlinkAlpha` with the same per-node FNV-1a desync, so the envelope in the table
  above is still the one thing on screen. Only the surface it tints stopped being a bake.

Constraints for Phase 26: stay within the 8-12fps quantized band; no full-keyframe
repaint flashes; idle must remain nearly free (active-set only).

### Bake-and-sprite mechanics, restated for the vector path (Phase 61, 2026-08-11)

The three mechanics this section used to describe in pixel-bake terms, restated from Phase
61's own locked values. **Every value named here is read from a shipped constant, not
re-typed as a bible literal**, so this block cannot drift from the renderer the way the
sentence above did.

| Mechanic | How it is drawn now | Source of truth |
|---|---|---|
| The belt **tread** | Procedural **vector path commands** built into ONE shared `GraphicsContext` per `(kind, chirality, phase bucket)`. The cache is **instance-scoped**, never a module global, and is rebuilt through a single regeneration path (`setPainter`) so a live knob change cannot leak contexts. | `render/synth/beltGeometry.ts` (commands), `render/synth/beltPainter.ts` (contexts), `render/synth/beltContextCache.ts` (lifetime) |
| The belt **corner** | **Self-sampled at a fixed sample count**, so no Pixi curve tessellator is ever reached and one fixed tessellation serves the whole zoom range. That is what removes the stale-curve hazard the pixel path never had and a naive vector path would have acquired. | `ARC_SAMPLES` / `LOD_ARC_SAMPLES` in `render/synth/beltGeometry.ts` |
| The **item dot** | Generated from **vector geometry** rather than hand-baked, then uploaded for the particle batch the layer must keep. The dot's LOOK is unchanged and gated as such; only its representation moved. | `render/layers/items.ts` |

**And the belt is no longer on this section's 10fps lattice.** The table above still governs
**machine sprite animation**, which stays deliberately chunky at 10fps over the bounded
24-frame loop. The belt tread marches on the **sim tick** instead (one tick per redraw), at
its own rate knob, with a separate bucket-count knob that no longer sets the speed. The two
clocks are allowed to differ and they still FREEZE together, because both derive from the
one render clock that reduced motion pins - so SAFE-02 needed no belt-specific branch.
**Determinism is untouched**: the march is a pure function of the sim render clock in tick
units, and no wall clock is reachable from any of it. That is the MOTION-01 property, held
at the new quantum exactly as at the old.

The one metric that split buys and must be read beside it: the render-clock resync snaps
the tread by **exactly half a dash period** in one frame, which is the maximally
direction-ambiguous displacement in a periodic pattern. It is ACCEPTED, not fixed, and both
available fixes are refused on the record at `render/layers/belts.ts`.

**BELT DIRECTION LOCKED 2026-07-26 (Phase 53): Direction B, blueprint / clean line** - a 10px/6px centreline dash at 2px stroke on 32px pitch, 1px inverted hairline rails over a hollow interior at 8.44:1, `elbowR` 15 / `laneHalf` 14 (a 4px corner pinch, the least of the five explored), marching 8px per phase at quantum 6 = 83.3px/s = 12.5% of item speed, with a 4.8px ringless item dot; the locked quantum IS the shipped `SIM_TICKS_PER_FRAME`, so **this section 4 table is NOT amended** and the tread stays on the 10fps quantized frame - the amendment was available and was declined; every locked cell is recorded in the belt-direction record (`53-BELT-LOCK.md`), which Phase 54 implements and re-blesses from. **Phase 57 reopened none of it.** It locked exactly one belt number, the lane WIDTH, which is section 2g above; SEED-012's `elbowR` 15 -> 16 and the lane-half change it implies are Phase 61's to carry, with the maintainer's signature on a written supersession.

**AMENDED BY PHASE 61, 2026-08-11 - the clause Phase 53 declined has now been taken, and this
paragraph is corrected in place rather than rewritten so the decision reads as a reversal with a
reason.** The sentence above says *"the locked quantum IS the shipped `SIM_TICKS_PER_FRAME`, so
this section 4 table is NOT amended and the tread stays on the 10fps quantized frame - the
amendment was available and was declined"*. Phase 61 took it. **The table is still not amended
for MACHINES** - 10fps, 24-frame loop, every number above unchanged - but the BELT TREAD is no
longer on it: it marches on the sim tick, at its own rate knob, with a bucket count that no longer
determines speed. Two facts make that a reversal on evidence rather than on taste. First, the
speed the art direction set did not move: the tread runs at the same physical pace the lock printed,
and Phase 61's own gate is that the speed is UNCHANGED across the change. Second, the reason the
lock could decline was that its `step` was WELDED to its bucket count (`step = pitch / K`), so
raising K for smoothness necessarily slowed the belt; Phase 61 split those into two knobs, which
is what made "smoother march at the same speed" reachable at all. The three lock cells this
paragraph transcribes that Phase 61 DID move - `elbowR` 15 -> 16, `laneHalf` 14 -> 10, and the
4 px corner pinch to 0 - moved under the signed `61-BELT-LOCK-SUPERSESSION.md` (maintainer,
2026-08-09), which is the only instrument that could move them. The `4.8px ringless item dot`
keeps its LOOK and changes only its representation (see the restatement block above).

---

## 5. State Matrix

Per element x per state: the exact visual. Selection and overlay are **board-drawn Graphics, NOT
a `state_tag`** - they are affordances layered over the asset, not baked into it.

**This section states what the art lock determines and marks what it does not.** The lock has
nine axes; per-state treatment is none of them. Rows below marked *(not locked)* are Phase 58's
(ART-02) to state, and this document does not fill them by inference.

| Element    | idle | working | faulted | selected | overlay |
|------------|------|---------|---------|----------|---------|
| machine    | **3u `ramp[4]` outline, no fill, no bevel, no shadow; kind carried by the 2u glyph** (lock axes 2, 3, 4, 7) | accent trim, 10 fps animated - **which part carries it is *(not locked)*** | fault accent trim + fault-blink (section 4) - **which part carries it is *(not locked)*** | + `build`-accent selection outline (board-drawn) | + fault-accent overlay ring (board-drawn) |
| belt       | centreline-dash tread, hollow ramp-0 interior, inverted ramp-4 hairline rails, at the **20 px lane** of section 2g | tread marches at 10 fps | inherits machine fault trim | n/a | n/a |
| item       | `item` accent dot | dot slides at 10 fps along belt | n/a | n/a | n/a |
| port nub   | *(not locked)* - port stubs were held constant across all four board directions, so the board compared chassis and glyph treatment only and stated nothing about the stub | working accent when its machine works | fault accent when faulted | n/a | n/a |
| selection  | absent | absent | absent | 2px `build`-accent ring drawn over the tile | n/a |
| alert ring | absent | absent | fault-accent ring (section 4 cadence) | n/a | n/a |
| ghost      | `build` accent at reduced coverage | n/a | n/a | n/a | placement preview only |

**State stays on the outline and the ring, never on a fill**, and that follows from the lock
rather than from taste: axis 3 locks an open chassis with no chassis fill, so there is no body for
a state colour to wash. This is the same structural fact that leaves ART-02's kind-family
encoding without a home (section 1b).

---

## 6. Chrome Tokens

Tokens derived from the locked skin so chrome and canvas stay one world. Every colour below
is a section 1 ramp INDEX, a section 1 reserved accent or a section 1c label colour, never a
hand-authored hex, which is what makes chrome and canvas the same world rather than two that
happen to match.

**Grounded in the two shipped emitters, and pinned to them in both directions.**
`frontend/src/render/synth/chrome/skinToCssVars.ts` stringifies the locked skin into the
`:root{ --fab-* }` block; `frontend/src/chrome/chromeCss.ts` is the stylesheet that consumes it.
`skinToCssVars.test.ts` asserts each value below against the emitter AND asserts the emitted
token SET equals this section's token set exactly, so a row added or removed on either side
reddens. The tables below are therefore exhaustive: all 34 emitted tokens appear.

> **28 -> 34 by phase 76 (D-05).** The six label colours of section 1c are emitted as
> `--fab-label-sand` through `--fab-label-clay` so the label panel's swatches read them and no
> hex is hand-written in chrome. Added to section 6a below; no other token moved.

> **30 -> 28 by the Phase 59 review (WR-05).** `--fab-icon-md` and `--fab-icon-lg` were emitted
> and documented here while no CSS rule, inline style or component read either. Both were
> deleted from the emitter and from section 6c in one commit; the count moves with them. No
> other token was touched and no VALUE moved.

> **Restated by Phase 59 (plan 59-05), discharging the open item this section carried.** The
> previous text was anchored on `board/chromeSample.ts` `bakeBezel`, a module the Phase 24 style
> board retirement deleted, and it stated the bevel depth, corner style and outline style in
> terms of `Skin` fields (`bevelDepth`, `cornerStyle`, `outlineStyle`) that SKIN-01 removed from
> the schema. Both banners it carried are gone because both conditions are discharged. **No token
> VALUE moved in the restatement:** what changed is the sourcing, the corrected per-side
> arithmetic, and the rows that were emitted but undocumented.

### 6a. Colour tokens (18)

| Token | Value | Source (`skinToCssVars`) |
|-------|-------|--------------------------|
| `--fab-substrate` | ramp index 0 (`#1b1f27`) | `skin.palette.ramp[0]` - the board ground behind the chrome |
| `--fab-panel-fill` | ramp index 2 (`#3b4250`) | `ramp.fill` - panel + neutral button interior |
| `--fab-edge-lit` | ramp index 4 (`#b0bacb`) | `ramp.tlLight` - the top/left band of the ring |
| `--fab-edge-shadow` | ramp index 0 (`#1b1f27`) | `ramp.brShadow` - the bottom/right band of the ring |
| `--fab-outline` | ramp index 0 (`#1b1f27`) | `ramp.brShadow` - the hairline band one step inside the ring |
| `--fab-ink` | ramp index 4 (`#b0bacb`) | `ramp.ink` - label ink, the contrasting extreme |
| `--fab-btn-neutral` | ramp index 2 (`#3b4250`) | `ramp.fill` - neutral / secondary button surface |
| `--fab-btn-primary` | `build` accent (`#4fa8ff`) | `accents.build` tints the primary / CTA button body |
| `--fab-focus` | `build` accent (`#4fa8ff`) | `accents.build` - the focus ring, byte-identical to `--fab-btn-primary` |
| `--fab-destructive` | `fault` accent (`#f0506e`) | `accents.fault` - destructive chrome affordances |
| `--fab-accent-working` | `working` accent (`#34d399`) | `accents.working` - Phase 39's CodeMirror theme paints string literals |
| `--fab-accent-item` | `item` accent (`#ffb454`) | `accents.item` - Phase 39's CodeMirror theme paints numbers/constants |
| `--fab-label-sand` | label colour 0 (`#e0d388`) | `palette.labels.sand` - the label swatch and box (section 1c) |
| `--fab-label-stone` | label colour 1 (`#a19d95`) | `palette.labels.stone` |
| `--fab-label-moss` | label colour 2 (`#a3c27f`) | `palette.labels.moss` |
| `--fab-label-lilac` | label colour 3 (`#bea2ea`) | `palette.labels.lilac` |
| `--fab-label-rose` | label colour 4 (`#e39ac0`) | `palette.labels.rose` |
| `--fab-label-clay` | label colour 5 (`#d68c6c`) | `palette.labels.clay` |

`--fab-focus` and `--fab-btn-primary` resolve to the SAME accent. That was measured in plan
59-04, not assumed, and it is stated here because a gate written over the accent NAMES that
omits `--fab-focus` leaves an accent-valued token outside its own scope.

Ramp steps 1 (`#2a2f3a`) and 3 (`#565f70`) are valid palette steps and are NOT consumed by
chrome. Introducing either as a chrome token means adding a row here in the same commit; the
set assertion is what enforces that rather than trusting the reader.

### 6b. Bezel ring tokens (3)

The bezel is a pure-CSS concentric inset ring as of plan 59-03. There is no raster, no
`border-image` and no nine-slice; the three rows that described one (`--fab-bezel-url`,
`--fab-bezel-slice`, `--fab-bezel-width`) were deleted in plan 59-05 along with the bake behind
them. The ring is PAINT: it reserves no space, so the chrome border box is identical at every
device pixel ratio where it used to differ at each one.

| Token | Value | Source (`skinToCssVars`) |
|-------|-------|--------------------------|
| `--fab-bezel-ring` | `6px`, constant at every DPR | `BEZEL_RING_CSS` - the sole declaration of the 6, carried from the retired bake's `BASE_RING` |
| `--fab-bezel-band` | `round(dpr)/dpr` px: `1.0000` / `0.8000` / `1.3333` / `1.0000` at DPR 1 / 1.25 / 1.5 / 2 | `bezelBandPx(dpr)` - a hairline SNAP, so each band is a whole number of device px |
| `--fab-bezel-ring-shadow` | three composed `inset` entries: shadow band, lit band, two-band outline | composed from `--fab-bezel-band`, `--fab-edge-shadow`, `--fab-edge-lit` and `--fab-outline` |

**The per-side composition of the 6px ring, corrected.** Per side it is **1 band lit-or-shadow
+ 1 band hairline outline + 4 px of body**, and the four body pixels are the element's own
`--fab-panel-fill` showing through rather than a painted band.

Two earlier statements of this arithmetic were both wrong, and are quoted so neither returns.
The retired `bezelUrl.ts` docblock said "1 lit + 1 shadow + 1 hairline inner outline + 3 body":
three body, measured wrong. A later correction said "1 lit + 1 shadow + 4 body": right on the
body count, but it drops the outline and implies the lit and shadow bands stack inward on the
SAME side. They do not. The bake painted lit on top and left, shadow on bottom and right, and
the shadow bands painted AFTER the lit ones, so a given side carries exactly one of them at
depth 0 and only the top-left corner reads lit. The CSS ring reproduces the measured bake: the
first-listed inset paints on top, so the shadow band LEADS the list, the lit band follows, and
the uniform two-band outline trails with its outer band fully covered - leaving one visible
hairline at depth 1. **The ring token LEADS every state shadow list; it does not end it**
(measured in Chromium, plan 59-03: an inset shadow always paints from the padding-box edge
inward, so a highlight listed first erases the frame it is meant to sit inside).

**The three retired bake sources, re-pointed with their values intact.** This section used to
state a corner style, an outline style and a bevel depth against `Skin` fields that SKIN-01
deleted, which then became module constants in `render/synth/generators.ts`. None of the three
values moved; what moved is where chrome reads them.

| Retired source | Value | Where chrome resolves it now |
|----------------|-------|------------------------------|
| corner style | `square` | nothing - **square by construction**. A composed inset band has no corner geometry to notch, so the chrome has no corner axis. The `square` / `clipped` branch survives only in the canvas-side bake primitive, which Phase 61 owns. |
| outline style | hairline, 1px | `--fab-bezel-band` - the hairline is one band, device-snapped, rather than a fixed 1 CSS px |
| bevel depth | 1px | `--fab-bezel-band` - the lit and shadow bands are one band each, the same snapped width |

The band token is what makes the 1px hairline honest at a fractional DPR: a flat `1px` at DPR
1.25 is 1.25 device px, which the compositor antialiases into one solid row plus a 25% blend
row. The snap holds every band at a whole number of device pixels.

### 6c. Icon size ladder (0 tokens - the ladder is not a CSS token)

The chrome icon size ladder is `ICON_MD_PX` 16 / `ICON_LG_PX` 24 in
`frontend/src/render/synth/chrome/iconSizes.ts`, and it reaches the DOM through the React
`px` prop only. **It emits no `--fab-*` token, deliberately.**

> **Corrected by the Phase 59 review (WR-05).** This sub-table listed `--fab-icon-md` and
> `--fab-icon-lg` and said "`iconSizes.ts` is the ONE declaration of the ladder, read by both
> the CSS custom property and the React `px` prop, so the two cannot drift." They could not
> drift because one of the two did not exist: `grep -rn "var(--fab-icon-" frontend/` returned
> nothing - no CSS rule, no inline style and no component read either token. Both rows were
> deleted from the emitter and from this section in one commit, which is what the bidirectional
> set gate requires. The precedent is named in the emitter's own spec: `--fab-bevel-depth` was
> removed for exactly this and is still asserted absent by name so it cannot come back without
> a consumer. The two icon rows are now asserted absent the same way.
>
> Sizing the icons from CSS instead was considered and rejected: an inline `width` from the
> `px` prop beats a `.fab-glyph svg { width: var(--fab-icon-md) }` rule in the cascade, so the
> token would still be dead, and the `px` value genuinely varies per call site (16 for the
> transport family and the Legend key, 24 for the Palette) rather than being a constant a
> stylesheet could carry.

### 6d. Spacing scale and hit target (8)

| Token | Value | Source (`skinToCssVars`) |
|-------|-------|--------------------------|
| `--fab-space-xs` | `4px` | the 8-point scale, migrated from the retired `theme.ts` shim |
| `--fab-space-sm` | `8px` | " |
| `--fab-space-md` | `16px` | " |
| `--fab-space-lg` | `24px` | " |
| `--fab-space-xl` | `32px` | " |
| `--fab-space-2xl` | `48px` | " |
| `--fab-space-3xl` | `64px` | " |
| `--fab-min-target` | `44px` | the minimum pointer-target edge |

### 6e. Typography (Phase 47, FEEL-05)

Chrome text is a smooth TWO-FONT vector system (the pixel-font text contract is
retired; `skinToCssVars.ts` + `skinToCssVars.test.ts` + this section are the
sync-guard triangle):

| Tier | Family | Token | Size token | Value |
|------|--------|-------|------------|-------|
| body / HUD | `"Martian Mono", monospace` | `--fab-font` | `--fab-font-size-base` / `--fab-font-size-hud` | 12px |
| title (wordmark + every panel/dialog heading, via `.fab-title`) | `"Sono", monospace` | `--fab-font-title` | `--fab-font-size-hero` | 18px, ALL-CAPS, weight 700, 0.5px tracking |

- Sizes are plain DPR-independent CSS px: the x16 device-snap contract is
  retired for TEXT (vector outlines are crisp at any size on any display).
- Both faces are OFL-1.1, self-contained VARIABLE woff2 assets (Vite-bundled,
  no runtime fetch; provenance in `frontend/src/assets/fonts/NOTICE.md`)
  declared with `@font-face` weight RANGES (`100 800` / `200 800`) so bold
  renders from the real axis, never synthesized.
- The nearest-neighbour rendering hint (`image-rendering: pixelated`) is GONE from the
  chrome entirely. This bullet used to say the hint "is UNCHANGED until Phase 59 retires
  the bezel's PNG data-URL: the 9-slice bezel, Legend sprite imgs, and canvas surfaces
  stay pixel-crisp". That condition has occurred, and the measurement behind the
  retirement went further than the condition did. Plan 59-03 found that NO module under
  `frontend/src/chrome/` carries a raster source at all - the Legend swatches are inline
  `<svg>`, and so is the port indicator - so all six surviving declarations were inert and
  were deleted, with an executable gate pinning the no-raster premise. What actually
  hardens those edges is `shape-rendering: crispEdges`, which is untouched. The hint now
  survives only on canvas surfaces, which Phase 61 owns.

---

## 7. Do-Not Examples

Every prohibition below is the negative form of a locked cell. Phase 58 and every phase after it
must reject these, and each names the axis it comes from so a reader can check it against the
lock rather than against this document.

**Authoring (sections 2a, 2b, 2e):**

- **No non-integer coordinate** in a `d` attribute. Integers only. *(axis 1)*
- **No `viewBox` outside the four literals.** Exact string equality against a closed whitelist, not
  a regex and not a divisibility test. *(axis 1)*
- **No third stroke weight.** 3u structural and 2u detail, and nothing else. *(axis 2)*
- **No detail stroke below 2u**, and no curve detail below it either. *(axis 8)*

**Geometry (sections 2c, 2d):**

- **No arc, and no curve command of any kind.** Radius 0, square. An authored arc imports Pixi's
  `buildAdaptiveBezier const scale = 1` stale-tessellation hazard into every shipped asset.
  *(axis 5)*
- **No rounded corner reintroduced as a chamfer either.** A chamfer is immune to the hazard and far
  cheaper than any arc, but it is NOT free in vertices - measured, it costs **+16 on a stroked
  outline and +8 on a fill** (section 2c). It is still not what is locked, and the refusal does not
  rest on cost: radius 0 is a locked value, not a compromise around a tooling limit. *(axis 5)*
- **No second filled path in an asset.** The ceiling is 1, as a maximum. *(axis 6)*
- **No asset over 400 vertices.** The batch cliff is silent - `isBatchable = vertices.length < 400`
  fails without an error. *(the 400-vertex budget)*

**Ink and light (sections 1b, 2f):**

- **No hand-authored hex in an asset.** Ink is a `LOCKED_SKIN.palette.ramp` index. *(axes 3, 7, 9)*
- **No shadow, no bevel, no blur, no gradient and no second light** on a machine asset. The offset
  is 0. *(axis 7)*
- **No brightness-multiply and no float shading.** Shading is ramp-index selection; a `* 0.8` tint
  anywhere in the asset path is a defect. *(carried: SYNTH-05)*
- **No kind-family hue invented here.** The scheme is "one ink for every kind"; the family VALUES
  are ART-02's and they have ART-03's colour-vision gate to satisfy first. *(axis 9)*

**Provenance and process (section 3d):**

- **No icon pack consulted, copied, traced or redrawn** - and never game-icons.net or Remix Icon,
  whose licences a redraw does not clear. *(section 2.10)*
- **No motif silently dropped.** All eight are carried; losing one in a redraw is the failure this
  bible's section 3c exists to catch. *(section 2.10)*
- **No art-board candidate imported into `svgAssets.ts`'s `ASSET_SOURCES` or its `AssetName`
  type.** The 32 candidates are DRAFTS, before the lock and after it. A draft that becomes
  importable is a draft that can ship by accident.
- **No belt lane width or elbow radius written into `frontend/shared/geometry.ts` without the maintainer's
  signature** on the written supersession of `53-BELT-LOCK.md` axis 3. *(section 2g)*

---

## 8. Board Retirement (post-lock follow-up)

**Two boards, two retirements.** This section carried the Phase 24 style board's retirement
procedure and now carries the Phase 57 art board's as well, in the same shape.

### 8a. The Phase 57 art board (`frontend/art-board.html`)

**How it is reached, and why there is nothing to unwire.** The board is a STANDALONE PAGE. Run
the dev server from `frontend/` (`npm run dev`, or `npx vite --host 127.0.0.1` - plain `npx vite`
binds localhost only, which the art-board specs trip over) and open `/art-board.html`. There is
no query flag, no runtime guard and no mention of the board anywhere in the app's own entry path
(`index.html` -> `src/main.tsx` -> `src/chrome/App.tsx`): `art-board.html` loads one module
script, `/src/spike/artBoard.ts`, and nothing in `src/` outside `src/spike/` imports it.

That absence is load-bearing rather than an implementation detail. BOARD-01's criterion is "a
standalone web page, not a live-canvas variant system", and a flag that puts the board on the
live canvas is the exact thing the criterion rules out. A separate page is also what keeps the
board structurally out of the production bundle: `vite.config.ts` declares no rollup input for
it, so `npm run build` emits `index.html` and `assets/` and nothing else -
`frontend/scripts/check-board-structure.sh` check 1 asserts that on every run, and check 5
asserts the board is unreachable from the app.

> **Corrected 2026-08-01 (verification W2).** This heading read `?artBoard=1` and the removal
> list below carried an `?artBoard` dev guard. Neither ever existed - a repo-wide grep over
> `*.ts`, `*.tsx`, `*.html` and `*.sh` returns zero hits. 8a was first written in 8b's shape and
> inherited 8b's mechanism on paper; 8b's `?styleBoard=1` guard was real, 8a's was not. The
> wrong text mattered because it contradicted the one property criterion 1 makes load-bearing,
> and it pointed a future retirement at code that is not there.

The machine art direction is now locked, so the art board has served its purpose. It stays LIVE
while the lock is re-judgeable - specifically until the locked direction has been judged on the
real WebKitGTK binary, which as of 2026-07-31 **has not happened**: the maintainer judged in the browser
only and said so, and the art lock's section 1 records that as an answer rather than an absence.
Retiring the instrument before its own verdict is complete would remove the only thing that can
re-render the comparison.

**What retirement removes, when it happens:** `frontend/art-board.html` (the page itself - there
is no guard block to unwire, which is what makes this retirement a delete rather than an edit),
`frontend/src/spike/` (the board modules, `artBoardGeometry.ts`, the slate, the channel panel and
their specs), `frontend/e2e/art-board.spec.ts`, `frontend/scripts/check-board-structure.sh` and
the 32 candidate drafts under `candidates/`.

**What SURVIVES it (the locked outputs):**

- the art-direction record (`57-ART-LOCK.md`) - the filled lock, and the
  only source this bible's sections 1, 2, 3, 5 and 7 draw from.
- `docs/style-bible.md` (this document).
- `scripts/check-neutrality.sh` - which scans this document and the lock, and which stays green
  by rewording copy, never by shortening its token list.

### 8b. The Phase 24 style board (`?styleBoard=1`)

Retired as a clean directory delete. The procedure, kept because it is the precedent 8a follows:

1. Delete `frontend/src/render/synth/board/` wholesale. The six variant data files
   (`variants.ts`), `styleBoard.ts`, `StyleBoardChrome.tsx`, `mixSkin.ts`,
   `scene.ts`, `beltItem.ts`, `chromeSample.ts` and their tests all live inside
   `board/`, so they die with the directory.
2. Remove the `import.meta.env.DEV && ?styleBoard` guard block from `App.tsx` and the
   `styleBoardRef` it populates (the dynamic `import('../render/synth/board/...')`
   goes with it).
3. Delete the board e2e spec (`frontend/e2e/styleBoard.spec.ts`) and the prod-exclusion
   assertion (`scripts/assert-no-styleboard-in-dist.mjs` + its `test:prod-exclusion`
   npm script) - both exist only to police the board's dev-only posture.

**What SURVIVES that retirement (the locked outputs):**

- `frontend/src/render/synth/skins/locked.ts` (`LOCKED_SKIN`. `HIGH_CONTRAST_SKIN` was also listed
  here until Phase 56 deleted it along with the rest of the theme system, SKIN-02.)
- `docs/style-bible.md` (this document)
- The additive `generators.ts` corner/outline change (the `cornerStyle` /
  `outlineStyle` support authored in Plan 24-01), which is a shipped-pipeline change,
  not board scaffolding.

Verification after either retirement: `npm run build` clean, `npm run test` green, and a grep for
the retired board's entry point over `frontend/dist` empty (already true; both boards are
dev-gated).
