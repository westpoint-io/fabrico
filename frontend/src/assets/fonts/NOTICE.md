# Font asset provenance

The fonts documented in this file are the project's approved binary-asset
exemption set: every embedded font binary must carry a provenance entry here
(author, license, source, retrieval date, SHA-256, size). All fonts are loaded
via `@font-face` (Vite-bundled, no runtime fetch). The retired pre-Phase-47
pixel ttf was deleted in plan 47-03 together with its entry (its provenance
lives in git history).

## MartianMono.woff2

- **Font:** Martian Mono, a monospaced grotesque typeface (variable, wght axis).
  The Phase 47 body/HUD face: all chrome running text renders in it at the 12px
  base.
- **Author:** Evil Martians (Roman Shamin et al.).
- **License:** SIL Open Font License 1.1 (OFL-1.1).
- **Source page:** https://github.com/evilmartians/mono (also on Google Fonts as
  "Martian Mono").
- **Sourced via:** Google Fonts css2 API, latin-subset VARIABLE woff2 (the
  `/* latin */` block's file URL).
- **Retrieved:** 2026-07-22
- **SHA-256:** d0be3a78a854bcea53a9dc26b6620ba322eaa515ccbd92bb4b6ec20a3c91b291
- **Size:** 23,556 bytes.
- **License text:** OFL-1.1-MartianMono.txt in this directory (fetched 2026-09-06 from
  https://raw.githubusercontent.com/evilmartians/mono/main/OFL.txt, sha256
  ddafd2c3f37ef1d83ef284ca63e159befd3820850c5e9eded14ca52eee92c256, 4,390 bytes).
  Quoted verbatim, unreflowed, with no added header: the sha256 and the size above are
  what a substituted copy would change.
- **Copyright notice, as embedded in the binary:** Copyright 2020 The Martian Mono Project
  Authors (https://github.com/evilmartians/mono). The upstream OFL.txt says 2021; both name
  the same authors, and the embedded string is the one that shipped, so it is the one
  quoted here.

### Usage

Single VARIABLE file carrying the whole weight axis: the css2 requests for
wght 400 and wght 700 serve byte-identical files, so ONE woff2 covers every
weight the chrome uses. Consumed via Vite import + an `@font-face` weight-RANGE
declaration (`font-weight: 100 800`) in App.tsx, so bold renders from the real
axis, never synthesized. No runtime fetch (offline-app invariant): the asset is
bundled and hashed by Vite.

**Re-fetch recipe** (if the file is ever lost): GET
`https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;700&display=swap`
with a modern Chrome User-Agent and take the `/* latin */` block's woff2 URL.

## Sono.woff2

- **Font:** Sono, a monospaced-leaning soft sans (variable, wght + MONO axes).
  The Phase 47 identity/title face: wordmark + panel titles, ALL-CAPS at 18px
  via the shared `.fab-title` class.
- **Author:** Tyler Finck (sursly).
- **License:** SIL Open Font License 1.1 (OFL-1.1).
- **Source page:** https://github.com/sursly/sono (also on Google Fonts as
  "Sono").
- **Sourced via:** Google Fonts css2 API, latin-subset VARIABLE woff2 (the
  `/* latin */` block's file URL).
- **Retrieved:** 2026-07-22
- **SHA-256:** b445e8587219e6c327a3e45bbb78ba52f67bbfa48fde98464472f5fa37b8d273
- **Size:** 31,560 bytes.
- **License text:** OFL-1.1-Sono.txt in this directory (fetched 2026-10-11 from
  https://raw.githubusercontent.com/google/fonts/main/ofl/sono/OFL.txt, sha256
  19d06d19f1720e1873105ce859318099f1a5322361007ce8f5a2b48463c33ad7, 4,377 bytes).
  Quoted verbatim, unreflowed, with no added header: the sha256 and the size above are
  what a substituted copy would change.
- **Copyright notice, as embedded in the binary:** Copyright 2020 The Sono Project Authors
  (https://github.com/sursly/sono). Read from the font's own `name` table (name ID 0) on
  2026-10-11; the upstream OFL.txt carries the same line word for word, so the two agree.

### Usage

Single VARIABLE file carrying the whole weight axis: the css2 requests for
wght 400 and wght 700 serve byte-identical files (verified live at retrieval).
Consumed via Vite import + an `@font-face` weight-RANGE declaration
(`font-weight: 200 800`) in App.tsx; the `.fab-title` tier uses weight 700 from
the real axis. No runtime fetch: bundled and hashed by Vite.

**Re-fetch recipe:** GET
`https://fonts.googleapis.com/css2?family=Sono:wght@400;700&display=swap`
with a modern Chrome User-Agent and take the `/* latin */` block's woff2 URL.

