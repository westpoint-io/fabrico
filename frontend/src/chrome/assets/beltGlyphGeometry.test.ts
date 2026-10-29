// beltGlyphGeometry.test.ts - the gate that holds `chrome/assets/belt.svg` to the belt
// geometry record (finding W-1 of the v7.0 milestone audit, 2026-08-11).
//
// WHY THIS FILE EXISTS. Plan 61-03 re-proportioned the chrome belt glyph to the 20u
// centreline spacing and the locked 10/6 dash rhythm, discharging `WINDOWS.md` row 29,
// and it recorded the reconciliation honestly in the asset's own header. But nothing
// MEASURED it: the three specs that touch this file (`lintSvg.test.ts`,
// `vertexBudget.test.ts`, `icons.test.tsx`) read no geometry constant, so the next edit
// to `BELT_GEOM.laneHalf` would have moved the canvas belt, left the glyph quoting a
// belt the board no longer draws, and reopened row 29 in silence. Wired by hand is not
// wired by construction. This is the construction.
//
// WHAT IS GATED, AND WHAT IS DELIBERATELY NOT. The Phase 59 DECOUPLING IS KEPT: the
// glyph does not derive from the canvas tread module, imports nothing and reads no
// constant, and this spec does not change that - it reads the committed markup as TEXT
// and compares PROPORTIONS. What it holds is exactly the relationship the asset's header
// states, no more:
//
//   GATED    rail CENTRELINE spacing, as a fraction of the glyph box, equals the canvas
//            lane (`2 * BELT_GEOM.laneHalf`) as a fraction of `CELL`.
//   GATED    the dash rhythm: inked run = `BELT_GEOM.dash`, clear run = `BELT_GEOM.gap`,
//            period = `BELT_DASH_PERIOD`, each as the same box-relative fraction.
//   NOT      the stroke WEIGHTS. 3u structural / 2u detail is the chrome's own
//            two-weight system (`53-BELT-LOCK.md` has no say over an icon's ink), and
//            the 2u tread weight equalling `BELT_GEOM.band` is a coincidence at this
//            scale, not a rule. Gating it would force the coupling Phase 59 rejected.
//   NOT      the OUTER-edge measure. It is 23u here and 20px on canvas, deliberately -
//            see the third gate below, which pins that divergence so a later reader
//            cannot "reconcile" it by comparing the wrong pair of edges.
//
// Text scan over committed first-party markup, no new dependency, in the
// strip-the-header-then-scan discipline `shippedAssets.test.ts` uses - so a docblock that
// NAMES a number cannot count as an occurrence of it. DOM-free: stays on the project
// default node environment.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BELT_DASH_PERIOD, BELT_GEOM, CELL } from '../../../shared/geometry.ts';

const GLYPH_PATH = join(import.meta.dirname, 'belt.svg');

/** The markup BELOW the `<!-- ... -->` header: the drawing, never the prose about it. */
function glyphBody(): string {
  const src = readFileSync(GLYPH_PATH, 'utf8');
  const end = src.indexOf('-->');
  expect(end).toBeGreaterThan(0); // a header-free file would make this scan vacuous
  return src.slice(end + 3);
}

/** The square glyph box edge, read from the committed `viewBox` (never assumed 32). */
function boxSize(body: string): number {
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(body);
  expect(m).not.toBeNull();
  const [w, h] = [Number(m![1]), Number(m![2])];
  expect(w).toBe(h); // a non-square box would make every fraction below ambiguous
  return w;
}

/** One `<path data-part="...">`: its `d`, its stroke weight. */
interface GlyphPath {
  d: string;
  strokeWidth: number;
}

function paths(body: string): Map<string, GlyphPath> {
  const out = new Map<string, GlyphPath>();
  for (const m of body.matchAll(/<path\s+([^>]*?)\/>/g)) {
    const attrs = m[1];
    const part = /data-part="([^"]+)"/.exec(attrs);
    const d = /\bd="([^"]+)"/.exec(attrs);
    const sw = /stroke-width="([\d.]+)"/.exec(attrs);
    if (!part || !d || !sw) continue;
    out.set(part[1], { d: d[1], strokeWidth: Number(sw[1]) });
  }
  return out;
}

/** A horizontal run `M x0 y H x1` -> its y, start x and end x. */
function hRun(p: GlyphPath): { y: number; x0: number; x1: number } {
  const m = /^M\s+([\d.]+)\s+([\d.]+)\s+H\s+([\d.]+)$/.exec(p.d.trim());
  expect(m).not.toBeNull();
  return { x0: Number(m![1]), y: Number(m![2]), x1: Number(m![3]) };
}

describe('chrome belt glyph agrees with BELT_GEOM (CHROME-01 x BELT-08)', () => {
  it('rail CENTRELINE spacing is the canvas lane, as a fraction of the box', () => {
    const body = glyphBody();
    const box = boxSize(body);
    const p = paths(body);
    const north = hRun(p.get('rail-north')!);
    const south = hRun(p.get('rail-south')!);

    // Compared as a FRACTION of the box, not as raw units, so the property survives a
    // future re-author at a different icon box: the glyph quotes the canvas lane's
    // proportion of a cell, which is what "the chrome must not quote a belt the board no
    // longer draws" actually means.
    const spacing = Math.abs(south.y - north.y);
    expect(spacing / box).toBe((2 * BELT_GEOM.laneHalf) / CELL);

    // The lane is centred: the two rails straddle the box centreline symmetrically.
    expect(north.y + south.y).toBe(box);
  });

  it('the dash rhythm is the locked run, gap and period', () => {
    const body = glyphBody();
    const box = boxSize(body);
    const p = paths(body);
    const west = hRun(p.get('tread-west')!);
    const east = hRun(p.get('tread-east')!);

    // Both runs ink `dash`; the clear span between them is `gap`; run + gap is the
    // period `CELL` divides wholly (the 0.00px straight-tile seam identity).
    expect((west.x1 - west.x0) / box).toBe(BELT_GEOM.dash / CELL);
    expect((east.x1 - east.x0) / box).toBe(BELT_GEOM.dash / CELL);
    expect((east.x0 - west.x1) / box).toBe(BELT_GEOM.gap / CELL);
    expect((east.x0 - west.x0) / box).toBe(BELT_DASH_PERIOD / CELL);

    // The dashes ride the lane CENTRELINE, which is the box centre (see gate 1).
    expect(west.y).toBe(box / 2);
    expect(east.y).toBe(box / 2);
  });

  it('the OUTER-edge measure is NOT the canvas lane, and that divergence is the point', () => {
    // The asset header's load-bearing word is CENTRELINES. At stroke-width 3 the glyph's
    // rails ink 4.5..7.5 and 24.5..27.5, so its outer-edge-to-outer-edge measure is 23u,
    // while `beltGeometry.ts` puts the canvas rails INSIDE the lane edge and measures 20
    // px OUTER edge to outer edge. The two are 20 for different reasons and the drawing
    // is right either way - the glyph's integer-and-EVEN coordinate contract forces its
    // choice. This assertion exists so a future reconciliation cannot "fix" the glyph by
    // comparing outer edge to outer edge and re-proportioning a correct file.
    const body = glyphBody();
    const box = boxSize(body);
    const p = paths(body);
    const north = p.get('rail-north')!;
    const south = p.get('rail-south')!;
    const outer =
      hRun(south).y + south.strokeWidth / 2 - (hRun(north).y - north.strokeWidth / 2);

    expect(outer).toBe(23);
    expect(outer / box).not.toBe((2 * BELT_GEOM.laneHalf) / CELL);
  });

  it('the Phase 59 decoupling holds: the glyph reads no constant and imports nothing', () => {
    // The mechanism, not the proportions. If this file ever gains a script, a `use`,
    // an `href` or an entity reference it has stopped being a hand-authored asset, and
    // the standing arrangement (two declarations, one owner phase, a recorded
    // reconciliation) has been replaced without a decision.
    const body = glyphBody();
    expect(body).not.toMatch(/<script|xlink:href|\bhref=|<use\b|<!ENTITY/i);
  });
});
