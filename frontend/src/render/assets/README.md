# Vector asset authoring contract

**This is the contract at the site.** Every `.svg` file in this directory is authored against the
rules below, and most of them are checked mechanically. If you are about to add or edit an asset,
read this first - the rules exist because Pixi v8's SVG parser fails *silently* in several of the
ways an author would most naturally reach for.

Assets are pulled into the bundle through Vite `?raw` by `../svgAssets.ts` and tessellated into ONE
shared `GraphicsContext` per asset. There is no runtime fetch, no asset directory to ship and no
rebake step: changing an asset's artwork is editing one path in one file (ART-05).

---

## What ships from this directory

**Nine `.svg` files sit FLAT here: the eight machine subjects plus `pilot.svg`.** Flatness is a
contract, not tidiness - the discovery walk in `scripts/lint-svg.ts`, `vertexBudget.test.ts` and
`geometryDigest.test.ts` is non-recursive, which is what keeps `candidates/` and `__fixtures__/`
out of the shipped tables without an ignore list. **A shipped asset in a subdirectory is an asset
no gate measures.**

| file | subject | `viewBox` | fills | vertices |
|---|---|---|---|---|
| `source.svg` | `Source` 1x1 | `0 0 32 32` | 1 | 32 |
| `sink.svg` | `Sink` 1x1 | `0 0 32 32` | 1 | 32 |
| `endpoint.svg` | HTTP endpoint 1x1 | `0 0 32 32` | 0 | 28 |
| `tee.svg` | `Tee` 2x2 | `0 0 64 64` | 0 | 24 |
| `balancer.svg` | `Balancer` 2x2 | `0 0 64 64` | 0 | 40 |
| `merge.svg` | `Merge` 2x2 | `0 0 64 64` | 0 | 32 |
| `router.svg` | `Router` 2x3 | `0 0 64 96` | 1 | 32 |
| `factory.svg` | `Factory` 3x3 | `0 0 96 96` | 0 | 64 |

284 vertices / 142 points across the eight, all measured. The fill ceiling across the set is **1**,
which is exactly lock axis 6's maximum.

### Every file carries the GLYPH ONLY

**The chassis is drawn in CODE** (`../layers/machineChassis.ts`), parametrically, at whatever
`w x h` the node's footprint actually is - a 4u-inset rectangle at `strokeStructural`. A design
decision of 2026-08-02, and it exists because a user can grow a machine through the shipped `+ Add output`
gesture: `grow_to_fit` clamps only at `MAX_FOOTPRINT_DIM = 64`, so a `Router` at base 2x3 becomes
2x6 and beyond, and **a grown machine has no legal `viewBox`**. Two numbers draw every footprint;
artwork cannot.

**The port stubs stay board-drawn** from the authoritative `ports[]` via `localNubSpecs` /
`drawRoleNub`, which already carry the role silhouettes, the fault ring and the state recolour.
Authoring them here would double-draw every nub and freeze a port layout into artwork.

Three consequences worth stating so they are not rediscovered:

- **There is no `chassis` part to exclude from a glyph-only measurement, and plan 58-04 must not
  build one.** ART-03's colour-vision gate measures glyph ink; with the chassis in code, the glyph
  ink *is* the whole asset. Every part in every file is glyph. An exclusion list for a `data-part`
  that exists in no committed file is a filter that silently matches nothing - it would read as a
  gate being careful while doing exactly nothing, which is the failure mode this milestone keeps
  finding. Grep before writing one: `data-part="chassis"` appears in `candidates/` only.
- **The `MERGE` / `BALANCER` pair must be able to FAIL that gate.** The ruling (2026-08-01) is
  that the pair is separated by glyph MASS DISTRIBUTION alone, and it explicitly refused the
  alternative that would have written an exemption into the gate. No exemption, no allowlist entry.
  Check `BALANCER` / `TEE` too - the Phase 57 lock recorded that as the adjacent real exposure.
- **The memoised context set is eight, not twenty-four.** The chassis no longer varies per
  `state x kind`, so it is not part of what gets tessellated per asset.

### The shipped colour rule (this is NOT the `candidates/` exemption)

Every colour literal in a shipped asset is exactly a `LOCKED_SKIN.palette.ramp` value, and in
practice every glyph is the single ink lock axis 9 permits: `ramp[4]`, `#b0bacb`. This is held by
the fail-severity ink allowlist in `shippedAssets.test.ts`, which asserts over the ramp VALUE SET
and reports the index each literal matched. The `candidates/` exemption below is grounded in "it
never ships" and does **not** extend here.

### The even-coordinate sub-module

Shipped machine art authored under `58-UI-SPEC.md` puts **every coordinate on the 2u sub-module** -
integers, and even. The detail stroke is 2u, so a 2u grid is the one on which every part centreline,
every mirror pair and every clearance between two strokes is expressible without a half-unit; the
`ENDPOINT` socket-wall / chevron-apex clearance is the worked example. It is enforced at fail
severity by `shippedAssets.test.ts` over the eight subjects, **not** by the subject-agnostic lint -
see that spec for why, and for the two committed bodies of correct SVG that predate the rule.

---

## The grid

- `viewBox` is **exactly one of four values**, matched as a literal string:

  | `viewBox` | Footprint | Kinds |
  |-----------|-----------|-------|
  | `0 0 32 32` | 1x1 | `Source`, `Sink`, `Belt`, `Endpoint`, `Wire` |
  | `0 0 64 64` | 2x2 | `Tee`, `Balancer`, `Merge` |
  | `0 0 64 96` | 2x3 | `Router` |
  | `0 0 96 96` | 3x3 | `Factory` |

  1 unit = 1 px at CELL 32 / scale 1, and **the 32-unit module holds on both axes**: a multi-cell
  kind is authored at `32*w` by `32*h` and **never at 32x32 scaled up**. Nothing else is legal -
  not `0 0 48 48`, and not `0 0 96 64` (a transposed `Router`: a multiple of 32 on both axes and a
  footprint no machine has). The lint compares by exact string equality against a closed list, not
  by a multiple-of-32 test.

  **The closure boundary.** These four are the **base** footprints of the nine subjects, read from
  the exhaustive `base_footprint` match in `crates/fabrico-core/src/state.rs`. `grow_to_fit`
  (PORT-07) can push a footprint past its base when ports are added, so the list is closed for the
  art authored in Phase 57 and is *not* "every footprint that can exist". Art authored against a
  grown footprint reopens the list rather than reading four literals as a complete inventory.
- **Every coordinate is an integer** (an optional leading `-` is allowed). Fractional author
  coordinates defeat the hard-edge promise at scale 1 and make the geometry digest sensitive to
  float representation.
- One `<path>` per semantic part, each carrying a stable, unique `data-part` matching
  `^[a-z][a-z0-9-]*$`. It is the hook that makes per-part tinting possible later without
  re-authoring geometry.
- **One element per line.** Diffs stay line-scoped. Free to check, so it is checked.
- Every `<path>` declares at least one of `fill` or `stroke` (`fill="none"` counts as declared). A
  path with neither renders as a silent **black fill** - Pixi's `renderChildren` sets
  `noStyle -> fillStyle = { color: 0 }`.

> **`viewBox` is enforced by the lint alone.** Pixi's `SVGParser` never reads it: coordinates pass
> straight through as user units. Pixi will happily draw a path at `x=900`. So the lint's
> four-value whitelist is the only thing holding the module across the whitelisted footprint set -
> there is no runtime that will disagree with a wrong box.

## Banned constructs

| Banned | Why |
|--------|-----|
| `transform` (anywhere) | **`SVGParser` never reads it.** Geometry lands untransformed with **no warning** - the worst failure mode in the set, because it looks like a drawing mistake. |
| `<use>`, `<defs>`, `<symbol>`, `<clipPath>`, `<mask>`, `<filter>`, `<image>`, `<text>`, `<style>` | `<use>` hits the parser's `default:` branch, warns, and draws **nothing**. `<defs>` is parsed only for gradients, and `radialGradient` warns and substitutes a *wrong* linear fallback. Banning them also keeps fills flat, which is what keeps assets inside the vertex budget. |
| `<g>`, and any non-`<path>` element | Not a parse guard (Pixi handles `<rect>`/`<circle>`/`<g>` fine) - a predictability rule. One primitive family keeps the vertex count and the geometry digest predictable, and a flat child list keeps a part's effective style local. |
| inline `style="..."` | Not a parse guard either: Pixi *does* read inline style and merges it over presentation attributes. Two channels for one property is what makes an SVG diff unreadable. |

## Curves - the VEC-03 obligation, and the one rule that is not obvious

**Pixi's `buildAdaptiveBezier` tessellates at a hardcoded `const scale = 1`.** Flatness is therefore
decided once, at authoring size, and the resulting geometry is *cached on the shared context*. Scale
that context up and the vertices transform per-vertex: the curve does **not** re-tessellate. So a
zoomed curve serves **stale, visibly faceted** geometry. Straight edges have no such problem - they
are exact at every scale, which is why the whole format leans on `M H V Z`.

Two rules follow, and only the first is mechanically checkable:

1. **Stay curve-light.** Prefer straight segments. A curve you did not need is a zoom defect you will
   not see until someone zooms.
2. **Any asset that must carry a curve re-plots its geometry on a zoom-bucket change** - it cannot
   be built once and scaled forever like a straight-edged asset can.

**The lint reports `C S Q T A` (both cases) at `fail` severity.** It was `warn` until plan 58-02,
held there as a deliberate abstention while BOARD-02 still owed a corner-radius policy. That policy
is locked - **axis 5: radius 0, authored square, zero curve commands** - so the abstention expired
with it, and Phase 58 raised the rule rather than leaving it at a severity nobody acts on. The
decision and its two reasons are recorded on `severityOf` in `scripts/lint-svg.ts`, in the source
they govern. **No rule is `warn` any longer**, and `lintSvg.test.ts` asserts that band is empty so
the claim stays checked.

An asset that genuinely needs a curve is not a lint waiver; it is a design conversation, because
rule 2 above means it cannot be built once and scaled forever like the rest of the format can.

## The vertex budget - read the unit twice

Pixi decides batchability with:

```js
gpuContext.isBatchable = gpuContext.geometryData.vertices.length < 400;
```

`vertices` is a **flat, stride-2 float array** (`buildContextBatches` computes point counts as
`vertices.length / 2`). So Pixi's threshold is fewer than 200 `(x, y)` points, not 400 points. The
budget is stated and asserted in **Pixi's own unit**, and every message prints both.

| Band | `vertices.length` | Equivalent points | Behaviour |
|------|-------------------|-------------------|-----------|
| OK | under 300 | under 150 | silent |
| Warn | 300 to 399 | 150 to 199 | named warning - the drift signal a bare hard-fail does not give |
| Fail | 400 or above | 200 or above | throw / test failure |

Crossing the cliff does not break rendering; it silently drops the asset out of the batch, which is a
frame-rate regression nobody can attribute. That silence is why the number is asserted rather than
watched.

For reference, `pilot.svg` measures **38 vertices / 39 indices / 3 batches** - the whole 32-unit
budget is generous for a flat-fill asset, and an asset approaching 300 is almost always over-detailed
rather than legitimately complex.

## `pixelLine` hairlines (D-12)

`stroke({ pixelLine: true })` is an API-side option, not an SVG attribute, so it is **not authorable
here and the lint cannot check it**. The constraint is render-side and enforced by review: a
`pixelLine` stroke uses a **line-list** topology that **cannot batch with triangles**. If hairlines
are used at all, they are grouped into one layer so the topology switch is paid once.

## `candidates/` - Phase 57 drafts that never ship

`render/assets/candidates/{a,b,c,d}/` holds Phase 57's art-board draft artwork. **None of it ships.**
It exists to be rendered side by side on `/art-board.html` so a direction can be locked; Phase 57
locks a *direction*, Phase 58 authors the art.

- **Invisible to the production walk.** The drafts live in a **subdirectory**, and both
  `lintDir()` and the geometry-digest walk are non-recursive `readdirSync` over
  `render/assets/*.svg`. That is the same mechanism that keeps `__fixtures__/` out, reused rather
  than reinvented - there is no ignore list to maintain.
- **They must never enter the shipped registry.** Not in `svgAssets.ts`'s `ASSET_SOURCES`, and not
  in its `AssetName` type. A draft that becomes importable is a draft that can ship by accident.
- **They are still authored against this contract in full** - the board is only worth judging if
  every cell obeys the same rules.
- **The literal-hex exemption extends to them**, for the identical reason it applies to
  `pilot.svg`: the standing rule (`spike/pixelGuard.tsx`) is that all colours come from
  `LOCKED_SKIN` via the real painters with no hand-authored hex, an SVG file necessarily carries
  literal hex, and these files never ship. Each draft states the exemption in its own header and
  names the `LOCKED_SKIN` ramp value every literal mirrors.

> **That question is now answered, and the answer is not this exemption.** Shipped artwork carries
> a literal, and the literal is constrained to the `LOCKED_SKIN.palette.ramp` VALUE SET by a
> fail-severity gate (`shippedAssets.test.ts`) rather than by a comment. See "The shipped colour
> rule" above. The `candidates/` exemption is grounded in "it never ships" and stops at this
> directory boundary.

## The pilot

`pilot.svg` is a **permanent calibration fixture**, not shipped art and not a temporary file. It is
deliberately not a machine and must not be "improved" toward one: it is the stable subject the
geometry gates keep forever, and the known-good reference to compare against when another asset
misbehaves. It is also the one file exempt from the "no hand-authored hex" rule - it never ships, and
its literals are the named `LOCKED_SKIN` ramp values. The exemption is written into the file itself;
read it there before copying the pattern into shipped artwork.
