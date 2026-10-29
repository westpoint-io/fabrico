# Phase 57 art-board candidates - drafts that never ship

**Everything in this directory is a DRAFT.** It exists to be rendered side by side on
`/art-board.html` so that a *direction* can be locked. Phase 57 locks a direction; **Phase 58 authors
the art**. Not one of these files is shipped artwork, and none of them is a starting point that is
"already half done" - Phase 58 draws the real thing against the locked direction.

## The hard boundary: these must never enter the shipped registry

- **Not in `svgAssets.ts`'s `ASSET_SOURCES`.** Not now, not "temporarily".
- **Not in its `AssetName` type.** A draft that becomes *importable* is a draft that can ship by
  accident, and the type is the thing that makes it importable.
- They live in a **subdirectory** so Phase 56's production walk never sees them: both `lintDir()` and
  the geometry-digest walk are **non-recursive** `readdirSync` over `render/assets/*.svg`. That is
  the same mechanism that keeps `__fixtures__/` out, reused rather than reinvented - there is no
  ignore list to maintain and nothing to remember.

They are nevertheless **authored against `render/assets/README.md` in full**, and held to it
mechanically by `candidateLint.test.ts` at `fail` severity. The board is only worth judging if every
cell obeys the same rules: a candidate that quietly broke the format would get its *direction* judged
on an artefact of the file rather than on the drawing.

## The colour-source exemption

The standing rule (`spike/pixelGuard.tsx`) is that **all colours come from `LOCKED_SKIN` via the real
painters, with no hand-authored hex**. An SVG file necessarily carries literal hex, so every file here
is exempt **because it never ships** - the identical reason `pilot.svg` is exempt, in the identical
wording. Each draft states the exemption in its own header by reference to this file and names the
`LOCKED_SKIN` ramp value every literal mirrors:

| Literal | `LOCKED_SKIN.palette.ramp` | Used for |
|---------|----------------------------|----------|
| `#1b1f27` | `ramp[0]` (substrate) | the board's cell background; in B and C, the knocked-out glyph |
| `#2a2f3a` | `ramp[1]` | the dark chassis/badge outline in B and C |
| `#3b4250` | `ramp[2]` | reserved; unused by all four directions |
| `#565f70` | `ramp[3]` | port stubs (all four); the chassis plate fill (B) and badge fill (C) |
| `#b0bacb` | `ramp[4]` (highlight) | chassis outline and glyph (A); port stubs (B); frame, traces and terminal pins (D) |

**Direction C reuses Direction B's paint system byte-for-byte, and that is a control rather than a
shortcut.** A vs B isolates the *treatment* with the geometry held fixed; B vs C isolates the
*silhouette* with the treatment held fixed. If C had also invented a palette, a reader preferring C
could not tell whether they were preferring kind-shaped silhouettes or a new colour scheme, and the
board would have measured two variables at once. **Direction D reuses Direction A's ink values** for
the same reason: D vs A then isolates *construction* (schematic traces and terminal pins) rather
than paint, which is what makes D-02's recorded "reads as a diagram rather than a factory" risk
visible instead of masked by a colour change.

> Whether **shipped** artwork carries literal hex or a per-part tint resolved from `LOCKED_SKIN` at
> render time is a **Phase 58 decision (ART-02)**. This exemption is not that decision and must not be
> read as it having been made.

## The four legal viewBoxes, and which subject uses which

Every candidate is authored at its **true base footprint**, never at 32x32 and scaled. If it were
scaled, a 3-unit stroke would rasterise at 9px on the `FACTORY` and 3px on a `SOURCE`, and the stroke
system BOARD-02 is supposed to lock would mean a different thing on every kind.

| `viewBox` | Footprint | Candidate stems |
|-----------|-----------|-----------------|
| `0 0 32 32` | 1x1 | `source`, `sink`, `endpoint` |
| `0 0 64 64` | 2x2 | `tee`, `balancer`, `merge` |
| `0 0 64 96` | 2x3 | `router` |
| `0 0 96 96` | 3x3 | `factory` |

**Eight stems per direction, never nine.** There are nine board subjects, but `BELT` is a board
subject and **not a candidate**: its art is already locked by `53-BELT-LOCK.md` (Direction B,
"Blueprint / clean line", the maintainers' lock, 2026-07-26, all 65 axis cells pinned). Belts are the
settled language the machine candidates are judged *against*.

## The vertex budget is footprint-independent

Measured through the real path (57-RESEARCH F2.1): identical geometry authored at `0 0 32 32` and at
`0 0 96 96` tessellates to **byte-identical** vertex counts. **A 96x96 `FACTORY` is not
budget-constrained relative to a 32x32 `SOURCE`**, and no candidate here is simplified on the belief
that it is. The measured per-primitive costs against the 400-vertex ceiling: a filled rectangle is 8
vertices (49 fit), a `stroke-width: 3` rectangle is 24 (16 fit), a rounded-rect outline at radius 3-8
is 104 (3 fit). **A stroke costs three times the fill of the same path.**

**Confirmed on the real art, and it overturns a description.** D-02 calls Direction D
("schematic / circuit", line-only) *"cheapest in vertices"*. Measured across all 32 candidates, D
is the **dearest** direction in the set:

| Direction | Total vertices | vs A |
|-----------|----------------|------|
| A - blueprint continuation | 604 | - |
| B - solid chassis plate | 668 | +64 |
| C - iconographic badge | 782 | +178 |
| D - schematic / circuit | **824** | **+220** |

D draws the *fewest marks* and costs the *most*, because every one of those marks is a stroke and
there is not one filled path in the direction. Its cost also scales with **port count** (each
terminal pin is a stroke), which no other direction's does. This is not a reason to re-open D-02 -
the direction is what it is, and it was drawn as described. It is the reason the board prints
**measured** numbers instead of letting anyone reason about cost from a direction's prose.

If a candidate lands in the `warn` band or over the ceiling, **that is a recorded finding about the
direction** - it goes to the board and to `57-ART-LOCK.md` section 5. It is *never* tuned away by
simplifying the art until it fits: that silently art-directs one direction to look cheaper than it is,
and then reads forever after as a design choice nobody made.

## Zero curves, by choice rather than by compliance

The `curve` lint rule is **warn** severity, deliberately: BOARD-02 owns the corner-radius policy and
this phase makes the cost visible without voting on it. Every candidate authored in plan 57-04 is
nevertheless curve-free, because `buildAdaptiveBezier` tessellates at a hardcoded `const scale = 1`
and caches the result on the shared context - so a curve authored here serves **stale, visibly
faceted** geometry at exactly the 1.77x and 2x rows the board exists to judge. Straight edges are
exact at every scale.

## ART-04 licence provenance

**ART-04 binds from the first candidate, not from the first shipped asset.** Provenance is authored
*with* each candidate, in its own file header, at the moment it is drawn. The reason is mechanical
rather than procedural: the lint has no way to detect a derived silhouette, and provenance
reconstructed after a lock is not provenance.

- **Material Symbols (Apache-2.0)** may be consulted as a **vocabulary reference only**, and any such
  consultation is recorded per candidate.
- **game-icons.net (CC-BY-3.0)** is **excluded outright** - redrawing does not clear a CC-BY
  obligation.
- **Remix Icon** is **excluded outright** - non-OSI, and its licence bans icon-pack redistribution.

A locked direction must never be one that cannot ship.

| Direction | Description | Provenance | Recorded |
|-----------|-------------|------------|----------|
| A - blueprint continuation | open chassis, structure carried by the 3u outline, minimal fill | **authored from scratch** for this board; no icon pack consulted, copied, traced or redrawn | plan 57-01 (`source`), plan 57-04 (the other seven) |
| B - solid chassis plate | filled chassis body, 3u dark outline, 2u glyph knocked out of the fill | **authored from scratch** for this board; no icon pack consulted, copied, traced or redrawn | plan 57-04 |
| C - iconographic badge | the silhouette itself differs per kind: a right-pointing plate (`source`), an octagon (`sink`), a notched socket (`endpoint`), a solid Y (`tee`), an H on its side (`balancer`), a funnel (`merge`), an elongated hexagon (`router`), a sawtooth-roof building (`factory`). B's paint system held constant | **authored from scratch** for this board; no icon pack consulted, copied, traced or redrawn | plan 57-05 |
| D - schematic / circuit | line-only with terminal pins at every port: right-angle routed traces, a square-wave generator, a ground symbol, a terminal block, an SPDT selector, a nested die. **Zero filled paths anywhere in the direction.** A's ink values held constant | **authored from scratch** for this board; no icon pack consulted, copied, traced or redrawn | plan 57-05 |

## The semantic vocabulary, carried or consciously rejected

`synth/glyphs.ts` already carries a per-kind motif vocabulary, and it is prior art: a spawn eye for
`SOURCE`, a bullseye for `SINK`, a fork for `TEE`, twin bars for `BALANCER`, a top-heavy funnel for
`MERGE`, a decision diamond for `ROUTER`, code braces for `FACTORY`. Every candidate header states
whether that motif is **carried** or **consciously rejected**, and with what. Silently losing it is
the failure mode this rule exists to prevent - a board where the motifs drifted per direction would be
comparing vocabularies rather than directions.

`ENDPOINT` is the exception with no motif to inherit: the shipped endpoint has **no chassis at all**,
only the asymmetric wire-terminal inlet glyph (`layers/inletGlyph.ts`, `INLET_HALF = 7`) drawn by the
wires layer at a port. Every `endpoint` candidate is therefore *proposing* a chassis where none exists
today, and says so in its header.

## The two gates

| Gate | Environment | What it holds |
|------|-------------|---------------|
| `candidateLint.test.ts` | node (the lint is DOM-free) | all twelve rules at `fail` severity, through the **exported** `lintDir`, plus the stated stem list and per-direction count |
| `candidateBudget.test.ts` | jsdom (`.svg()` calls `document.createElement`) | non-zero geometry and the vertex band, through the **exported** `classifyVertexCount`, never a mirrored threshold |

Both state their counts as **literals** (`EXPECTED_PER_DIRECTION = 8`,
`EXPECTED_CANDIDATE_COUNT = 32`) and never derive them from a directory listing: an assertion computed
from the same source it is checking cannot fail. Both pair every zero-violation claim with a
**discovered-count** assertion, so a walker that found nothing cannot report a clean green. Plan 57-05
raised those literals from 16 to 32 in the same edit that added the `c/` and `d/` art, so the bump is
visible in the diff.

**32, not 36.** Nine board subjects times four directions is 36; `BELT` is a subject but not a
candidate, and its four absent cells are the whole difference.
