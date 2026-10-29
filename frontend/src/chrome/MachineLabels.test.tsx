// MachineLabels.test.tsx (66-03, WIRE-03) - the Alt-hold chip's TEXT.
//
// WHY THIS FILE EXISTS. `MachineLabels.tsx` pushes a chip for every non-BELT node and
// rendered it as a bare `{KIND_NAMES[c.kind]}`. `KIND_NAMES` had no key 9, so an HTTP
// Endpoint drew a bordered, substrate-backed chip containing NO TEXT - and this was
// already shipping, because the demo scene carries a pre-placed Route. Nothing in the
// tree asserted the chip's text at all.
//
// 72-10 (D-10) folded the endpoint's separate name table into `KIND_NAMES` and the
// chip's fall-through lost its middle arm. The cases below moved with it: the SUBJECT
// changed, the QUESTION did not. Each still asks "does every node this overlay draws
// read a name, and does it read the SHARED one".
//
// WHY IT RENDERS RATHER THAN WALKING THE TREE. The sixteen other chrome specs invoke
// their component directly and walk the returned `{ type, props }` descriptors, which
// works because those components are HOOK-FREE by design. `MachineLabels` is not: it
// holds `useState`, `useRef` and `useLayoutEffect` (the per-frame anchor loop), so a
// direct call throws outside a renderer. `renderToStaticMarkup` runs the state
// initializer - which is what seeds the chip list from the live handle - skips the
// layout effect, and returns the real markup the component produces. That is the only
// way to assert what a user actually reads on the chip.
//
// The fake handle is the minimum `readChips` touches: `sceneState.nodes`, a Map of
// NodeView-shaped records. Nothing here reaches Pixi, a canvas or a camera.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MachineLabels } from './MachineLabels.tsx';
import { KIND_NAMES, KIND_LEGEND_ORDER } from './kindNames.ts';
import { machine_kind, state_tag } from '../protocol/kinds.ts';
import type { SceneHandle } from '../render/pixiApp.ts';

/** A NodeView-shaped record - only the fields `readChips` and the anchor loop read. */
function node(id: number, kind: number): Record<string, number> {
  return { id, kind, cell_x: 2, cell_y: 3, w: 1, h: 1, rot: 0, state: state_tag.IDLE };
}

/** A `handleRef` carrying exactly the nodes given, and nothing else. */
function handleFor(...nodes: Record<string, number>[]): RefObject<SceneHandle | null> {
  const map = new Map<number, unknown>();
  for (const n of nodes) map.set(n.id as number, n);
  return { current: { sceneState: { nodes: map } } as unknown as SceneHandle };
}

/** The text content of every rendered chip, in render order. */
function chipTexts(...nodes: Record<string, number>[]): string[] {
  const html = renderToStaticMarkup(createElement(MachineLabels, { handleRef: handleFor(...nodes) }));
  return [...html.matchAll(/data-testid="machine-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
}

describe('the Alt-hold chip resolves a NAME for every node it draws (66-03, D-10)', () => {
  it('renders "Route" for a kind-9 node instead of an empty bordered box', () => {
    // THE DEFECT, STATED AS THE ASSERTION. Before a fall-through existed this read
    // `['']`: a chip with a border, a substrate and no text. The name is now 'Route'
    // (D-09) and it comes from the same map every other kind's does.
    expect(chipTexts(node(9, machine_kind.ENDPOINT))).toEqual(['Route']);
  });

  it('renders "HTTP Handler" for a kind-10 node (D-11), from that same map', () => {
    // Kind 10 read 'Machine' at HEAD - the final catch-all arm, which is the same
    // defect class one step quieter than an empty box: a name that names nothing.
    expect(chipTexts(node(10, machine_kind.HANDLER))).toEqual(['HTTP Handler']);
  });

  it('reads both names from the shared map, not from a string in this component', () => {
    // `MachineLabels.tsx` must not carry its own literal: the Legend row, the
    // ConfigPanel heading and this chip resolve ONE string each, which is what D-10
    // makes structural rather than conventional.
    expect(chipTexts(node(9, machine_kind.ENDPOINT))[0]).toBe(KIND_NAMES[machine_kind.ENDPOINT]);
    expect(chipTexts(node(10, machine_kind.HANDLER))[0]).toBe(KIND_NAMES[machine_kind.HANDLER]);
  });

  it('is "Route" and NOT "HTTP Endpoint" - the old palette-only long form is gone', () => {
    // The palette row and the kind name are now THE SAME STRING for kind 9. 66-UI-SPEC
    // allowed a longer disambiguating palette label ('HTTP Endpoint' over 'Endpoint');
    // 72-UI-SPEC 2.3 spends that allowance the other way, because 'Route' needs no
    // disambiguator once the 'HTTP Router' row it could be confused with is pulled.
    expect(chipTexts(node(9, machine_kind.ENDPOINT))[0]).toBe('Route');
  });

  it('still renders each of the KIND_NAMES kinds under its own name', () => {
    // The fall-through must not shadow the first arm. Driven from the map itself, so a
    // kind added to `KIND_NAMES` is covered without editing this list.
    for (const key of Object.keys(KIND_NAMES).map(Number)) {
      if (key === machine_kind.BELT) continue; // a belt is not a machine to name here
      if (key === machine_kind.LABEL) continue; // a label shows its own words (76-03, D-09)
      expect(chipTexts(node(1, key)), `kind ${key}`).toEqual([KIND_NAMES[key]]);
    }
  });

  it('draws NO chip for a BELT node', () => {
    expect(chipTexts(node(1, machine_kind.BELT))).toEqual([]);
  });

  it('draws NO chip for a LABEL node, and a chip for every machine beside it (76-03, D-09)', () => {
    // 76-UI-SPEC 4.3: a label already shows its own words; a chip reading "Label" over
    // them would compete with them. Every other kind on the board keeps its chip.
    expect(chipTexts(node(1, machine_kind.LABEL))).toEqual([]);
    const machines = Object.keys(KIND_NAMES)
      .map(Number)
      .filter((k) => k !== machine_kind.BELT && k !== machine_kind.LABEL);
    const board = [node(1, machine_kind.LABEL), ...machines.map((k, i) => node(i + 2, k))];
    expect(chipTexts(...board)).toEqual(machines.map((k) => KIND_NAMES[k]));
  });

  it('never renders an EMPTY chip for any node on the board', () => {
    // The general form of the defect. A chip whose text is empty is a bordered box that
    // tells the user nothing, which is strictly worse than no chip at all.
    const every = Object.values(machine_kind).filter((k) => k !== machine_kind.BELT);
    for (const kind of every) {
      for (const text of chipTexts(node(1, kind))) {
        expect(text.length, `kind ${kind} chip text`).toBeGreaterThan(0);
      }
    }
  });

  it('KIND_NAMES IS the single source, and KIND_LEGEND_ORDER is its ordered Legend view', () => {
    // WAS: "KIND_NAMES is NOT grown to fix this: still eight entries, still no key 9", which held
    // the wrong fix shut on the grounds that the Legend ITERATES this map. D-10 established that it
    // does not: the Legend iterates KIND_LEGEND_ORDER, an ordered VIEW. Until phase 92 that view
    // stayed at the eight reviewed kinds; phase 92 (D-03, UI-SPEC 1.2) makes it palette order, so
    // Route, HTTP Handler and Label are kind rows too. The name map stays the one source the view
    // looks its names up in.
    expect(KIND_NAMES[machine_kind.ENDPOINT], 'the name map covers kind 9').toBe('Route');
    expect(KIND_NAMES[machine_kind.HANDLER], 'the name map covers kind 10').toBe('HTTP Handler');
    expect(KIND_LEGEND_ORDER, 'the ordered Legend VIEW is the eleven palette entries').toHaveLength(11);
    expect(KIND_LEGEND_ORDER).toEqual([0, 7, 2, 3, 4, 6, 9, 10, 5, 1, 11]);
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.ENDPOINT);
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.HANDLER);
    expect(KIND_LEGEND_ORDER).toContain(machine_kind.LABEL);
  });
});

// Phase 91, plan 91-09 (CHROME-08, D-07, UI-SPEC 3): name tags sit UNDER every chrome surface.
// The layer is zIndex 1 (the chrome is 2, the Examples popover 3) and takes no pointer events;
// App mounts it just after `LabelWords` (also 1), so a tag still paints over a label's words.
describe('the name-tag layer sits under every panel (CHROME-08, D-07)', () => {
  it('renders its layer at zIndex 1 with no pointer events', () => {
    const html = renderToStaticMarkup(createElement(MachineLabels, { handleRef: handleFor(node(1, machine_kind.SOURCE)) }));
    const layer = /^<div[^>]*style="([^"]*)"/.exec(html);
    expect(layer, 'the layer is the outermost div').not.toBeNull();
    expect(layer![1]).toContain('z-index:1');
    expect(layer![1]).not.toContain('z-index:2');
    expect(layer![1]).toContain('pointer-events:none');
  });

  it('is mounted in App after LabelWords (comments stripped)', () => {
    const src = readFileSync(join(import.meta.dirname, 'App.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const words = src.indexOf('<LabelWords');
    const tags = src.indexOf('<MachineLabels');
    expect(words, 'App mounts LabelWords').toBeGreaterThan(-1);
    expect(tags, 'App mounts MachineLabels').toBeGreaterThan(-1);
    expect(src.indexOf('<MachineLabels', tags + 1), 'once').toBe(-1);
    expect(tags, 'MachineLabels mounts after LabelWords').toBeGreaterThan(words);
  });
});
