# docs/brand/

The project's brand sources. **Nothing in the app imports anything in this directory**: no
component, no Vite input and no bundle reaches `docs/`, so a file here is a brand source rather
than a shipped asset. The app's own artwork lives under `frontend/src/chrome/assets/` and
`frontend/src/render/assets/`.

## What is here

| File | What it is |
|---|---|
| `fabrico-lockup.svg` | The Fabrico wordmark lockup, and the primary brand artefact. Every later surface (README hero, social card, favicon cuts) is cut from it. |
| `fabrico-icon-master.svg` | The literal-colour master of the Fabrico mark (MARK-06): the three shapes of the token painted square in `frontend/src/chrome/assets/logomark.svg` (no longer rendered in the app since 2026-10-11), painted in resolved hex on a full-bleed plate, on a 32-unit box. Every installer raster is cut from it. |
| `fabrico-icon-16.svg` | The 16-unit **optical cut** (MARK-05): the drawing the operating system paints below 24px. One author unit is one device pixel at 16px. **Authored on its own grid, never resampled from the master**: its belt is a solid ink bar rather than the master's filled-and-stroked band, which is the whole reason it exists. |
| `fabrico-icon-stencil.svg` | The monochrome stencil (MARK-07): one colour, **no plate**, and a silhouette carrying a real hole, so a tray or menu-bar fill cannot collapse it to a solid square. |

The three icon cuts are emitted by `frontend/scripts/build-icons.ts` and regenerated rather than
edited:

```bash
npm run build:icons       # from frontend/
```

One command produces all three cuts and the 128px installer raster, and
`frontend/src/render/assets/iconCuts.test.ts` rebuilds each of them in memory and compares byte
for byte against what is committed, so a hand edit reddens the unit suite. Each file's own header
carries its ART-04 provenance and, for the 16-unit cut, the one place it deliberately departs from
half scale.

## `fabrico-lockup.svg` is generated, not drawn

It is emitted by `frontend/scripts/build-lockup.ts` and regenerated rather than edited:

```bash
npm run build:lockup      # from frontend/
```

The word and the tagline are outlined `<path>` geometry, produced by reading the committed
`frontend/src/assets/fonts/MartianMono.woff2` directly, so the drawing renders identically with
no font installed anywhere. `frontend/src/render/assets/lockup.test.ts` rebuilds the file in
memory and compares it byte for byte against what is committed, so a hand edit reddens the unit
suite. **A change to this artwork is a change to the generator followed by a regeneration.**

The file's own header carries its full ART-04 provenance: the face, the foundry, the licence, the
exact source binary with its sha256 and byte size, the sizes and tracking the outlines were
generated at, and how the amber item is anchored.

`docs/brand/` is walked by `npm run lint:svg` (from `frontend/`) under a subject-agnostic subset
of the SVG dialect: `malformed-xml`, `banned-element`, `path-only`, `no-paths`, `explicit-paint`,
`one-element-per-line` and `comment-hyphen`. The 32-unit viewBox whitelist, the integer-coordinate
rule, the no-curve rule and the chrome ink rule are deliberately **not** applied here: the lockup
is a wide horizontal drawing that never sat on the chrome grid.

This sentence listed five of the seven until 2026-09-06: plan 80-05 added `comment-hyphen` and
`no-paths` was missing outright, which is what let a zero-path SVG dropped into this directory lint
clean. `frontend/scripts/lint-svg.ts`'s `BRAND_RULES` is the only authority on the list, and
`lintSvg.test.ts` measures it.

## Font licence

Martian Mono is licensed under the SIL Open Font License 1.1.

- Licence text: `frontend/src/assets/fonts/OFL-1.1-MartianMono.txt`, quoted verbatim.
- Provenance of the binary the outlines came from (author, source, retrieval date, sha256, size):
  `frontend/src/assets/fonts/NOTICE.md`.

## Colour

**The register rule: a brand colour never paints anything the app itself paints.**
Brand colours are named outside `LOCKED_SKIN` and are spent here, on brand surfaces only.

Exactly two of the register are spent by this artwork:

| Hex | Where it is spent |
|---|---|
| `#8a94a6` | The belt structure: rail, drums, hubs, cleats and the dot grid. |
| `#6d7481` | The tagline, `THE GRID IS THE PROGRAM`. |

The four other values in the file are **not** brand colours. `#1b1f27`, `#3b4250`, `#b0bacb` and
`#ffb454` are `LOCKED_SKIN` values (the ground, the panel fill, the ink and `fab-accent-item`)
written as literals because a brand source cannot resolve a CSS custom property. They spend
nothing from the register.

**The three icon cuts introduce no colour outside those four**, so the register table above is
unchanged by them and gains no row. The master spends all four; the 16-unit cut spends the ground,
the ink and `fab-accent-item`; the stencil spends the ink alone, and it is the mark's own ink
rather than black precisely so that a monochrome cut is still a Fabrico colour. Every one of those
values is read out of `skinToCssVars(LOCKED_SKIN)` by the generator at build time and never
transcribed into it.
