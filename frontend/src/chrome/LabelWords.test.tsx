// LabelWords.test.tsx (phase 76, plan 76-02, SHAPE-10, D-06) - the words overlay.
//
// `LabelWords` holds state, a ref and a layout effect, so (like `MachineLabels.test.tsx`)
// it is rendered with `renderToStaticMarkup`, which runs the state initializer that seeds
// the element list from the live handle and skips the per-frame effect. That is the real
// markup the component produces before its first frame. The visibility and layout rules
// are exported pure functions and are asserted directly.

import { describe, expect, it } from 'vitest';
import { createElement, type RefObject } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LABEL_WORDS_MIN_ZOOM,
  LabelWords,
  labelWordsShown,
  readLabelWords,
  textAreaOf,
} from './LabelWords.tsx';
import { machine_kind, state_tag } from '../protocol/kinds.ts';
import type { SceneHandle } from '../render/pixiApp.ts';

/** A NodeView-shaped record carrying only what the overlay reads. */
function node(
  id: number,
  kind: number,
  label: { text: string; colour: number } | null,
  w = 4,
  h = 1,
): Record<string, unknown> {
  return { id, kind, cell_x: 10, cell_y: 12, w, h, rot: 0, state: state_tag.IDLE, ports: [], load: 0, label };
}

function handleFor(...nodes: Record<string, unknown>[]): RefObject<SceneHandle | null> {
  const map = new Map<number, unknown>();
  for (const n of nodes) map.set(n.id as number, n);
  return { current: { sceneState: { nodes: map } } as unknown as SceneHandle };
}

function markup(...nodes: Record<string, unknown>[]): string {
  return renderToStaticMarkup(createElement(LabelWords, { handleRef: handleFor(...nodes) }));
}

describe('LabelWords - which labels get a words element', () => {
  it('draws one element per label WITH words, carrying data-testid and data-node', () => {
    const html = markup(node(7, machine_kind.LABEL, { text: 'Order intake', colour: 0 }));
    const hits = [...html.matchAll(/<div data-testid="label-words" data-node="(\d+)"[^>]*>([^<]*)<\/div>/g)];
    expect(hits.map((m) => [m[1], m[2]])).toEqual([['7', 'Order intake']]);
  });

  it('draws NO element for a label with empty text', () => {
    expect(markup(node(7, machine_kind.LABEL, { text: '', colour: 0 }))).not.toContain('label-words');
    expect(readLabelWords(handleFor(node(7, machine_kind.LABEL, { text: '', colour: 0 })).current)).toEqual([]);
  });

  it('draws nothing for a machine, whatever it carries', () => {
    const html = markup(
      node(1, machine_kind.FACTORY, null),
      node(2, machine_kind.SOURCE, { text: 'not a label', colour: 0 }),
    );
    expect(html).not.toContain('label-words');
  });

  it('renders typed markup as TEXT: no element is parsed out of <b> (T-76-04)', () => {
    const html = markup(node(7, machine_kind.LABEL, { text: '<b>x</b>', colour: 0 }));
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });

  it('starts every element hidden until its first transform is written (no origin flash)', () => {
    const html = markup(node(7, machine_kind.LABEL, { text: 'Order intake', colour: 0 }));
    const el = html.match(/<div data-testid="label-words"[^>]*>/)?.[0] ?? '';
    expect(el).toContain('visibility:hidden');
  });

  it('is a pointer-events:none, aria-hidden layer at z-index 1', () => {
    const html = markup(node(7, machine_kind.LABEL, { text: 'x', colour: 0 }));
    const root = html.match(/^<div[^>]*>/)?.[0] ?? '';
    expect(root).toContain('aria-hidden="true"');
    expect(root).toContain('z-index:1');
    expect(root).toContain('pointer-events:none');
  });
});

describe('LabelWords - layout and visibility rules (76-UI-SPEC 4.2)', () => {
  const onScreen = { x: 100, y: 100, width: 112, height: 16 };

  it('hides the words below zoom 0.75 and shows them at exactly 0.75 (inclusive)', () => {
    expect(LABEL_WORDS_MIN_ZOOM).toBe(0.75);
    expect(labelWordsShown(0.74, onScreen, 1280, 800)).toBe(false);
    expect(labelWordsShown(0.75, onScreen, 1280, 800)).toBe(true);
    expect(labelWordsShown(4, onScreen, 1280, 800)).toBe(true);
  });

  it('the boundary is exact: shown at 0.75, hidden at 0.7499 (plan 76-03, D-06)', () => {
    expect(labelWordsShown(LABEL_WORDS_MIN_ZOOM, onScreen, 1280, 800)).toBe(true);
    expect(labelWordsShown(0.7499, onScreen, 1280, 800)).toBe(false);
  });

  it('hides the words while the label is wholly off screen, on any side', () => {
    expect(labelWordsShown(1, { x: -200, y: 100, width: 112, height: 16 }, 1280, 800)).toBe(false);
    expect(labelWordsShown(1, { x: 1300, y: 100, width: 112, height: 16 }, 1280, 800)).toBe(false);
    expect(labelWordsShown(1, { x: 100, y: -40, width: 112, height: 16 }, 1280, 800)).toBe(false);
    expect(labelWordsShown(1, { x: 100, y: 900, width: 112, height: 16 }, 1280, 800)).toBe(false);
    // Partly on screen is shown: the overlay clips the rest.
    expect(labelWordsShown(1, { x: -50, y: 100, width: 112, height: 16 }, 1280, 800)).toBe(true);
  });

  it('lays the words in a text area inset 8 world px, 2h - 1 lines of 16', () => {
    expect(textAreaOf(4, 1)).toEqual({ width: 112, height: 16, lines: 1 });
    expect(textAreaOf(6, 2)).toEqual({ width: 176, height: 48, lines: 3 });
    expect(textAreaOf(16, 8)).toEqual({ width: 496, height: 240, lines: 15 });
  });

  it('clamps the element to its lines and wraps inside its width', () => {
    const html = markup(node(7, machine_kind.LABEL, { text: 'x', colour: 0 }, 6, 2));
    const el = html.match(/<div data-testid="label-words"[^>]*>/)?.[0] ?? '';
    expect(el).toContain('width:176px');
    expect(el).toContain('max-height:48px');
    expect(el).toContain('white-space:pre-wrap');
    expect(el).toContain('overflow-wrap:anywhere');
    expect(el).toContain('-webkit-line-clamp:3');
  });
});
