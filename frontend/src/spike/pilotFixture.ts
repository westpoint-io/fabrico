// pilotFixture.ts (phase 91 plan 91-03, CHROME-06, D-05) - the pilot calibration fixture,
// reachable only from the dev fixture pages and the tests.
//
// `render/assets/pilot.svg` is the permanent vector calibration fixture (plan 56-01): the
// subject of the `vector-pilot` pixel baseline on the dev-only `pixel-guard.html` page and of
// the geometry digest and vertex budget cases. It used to be a row of the shipped asset table
// in `render/svgAssets.ts`, so its text (including a comment saying it never ships) rode the
// app's bundle into `dist/` and the Tauri binary. It now lives here, under `src/spike/`, which
// `vite.config.ts`'s `devFixtureGuardPlugin` refuses by path in a build: an import of this
// module from the app fails `npm run build` by name.
//
// THE FILE STAYS IN `render/assets/`. `shapeDistinctness.test.ts` and the lint and budget
// walkers read that directory on disk, and the fixture is held to the same format rules as the
// shipped subjects; only the import moved.
//
// ITS OWN MEMO, built the way `getAssetContext` builds a shipped asset (parse, tessellate,
// DEV-measure, cache), so the identity assertions over the pilot keep their meaning: N
// drawings of the fixture share ONE `GraphicsContext`, returned by identity on every call.

import { GraphicsContext } from 'pixi.js';
import PILOT_SVG_RAW from '../render/assets/pilot.svg?raw';
import { assertVertexBudget, measureContext } from '../render/svgAssets.ts';

/**
 * The pilot calibration fixture's raw SVG text. Exported so a spec can measure or mutate it in
 * memory without going through the memoised context (a digest demonstration must mutate a COPY
 * of the source, never the shared context).
 */
export const PILOT_SVG: string = PILOT_SVG_RAW;

let pilotContext: GraphicsContext | null = null;

/**
 * The ONE shared `GraphicsContext` for the pilot, built on first call and returned by IDENTITY
 * thereafter. In DEV the freshly built context is measured against the vertex budget once, as
 * `getAssetContext` measures a shipped asset.
 */
export function getPilotContext(): GraphicsContext {
  if (pilotContext !== null) return pilotContext;
  const ctx = new GraphicsContext().svg(PILOT_SVG);
  if (import.meta.env.DEV) {
    assertVertexBudget('render/assets/pilot.svg', measureContext(ctx));
  }
  pilotContext = ctx;
  return ctx;
}
