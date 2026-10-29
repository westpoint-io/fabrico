import { describe, expect, it } from 'vitest';
import { SinkConfigBody, HTTP_METHODS } from './SinkConfigBody.tsx';
import type { SinkTemplate } from '../protocol/decode.ts';

// Node env, no DOM: SinkConfigBody is a pure function (props in, callbacks out),
// invoked directly with its sub-parts inlined as render helpers, so the returned
// tree carries the real <button>/<input> nodes we walk (the DeleteControl
// direct-invocation discipline).

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function walk(node: unknown, visit: (el: El) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (!isEl(node)) return;
  visit(node);
  walk(node.props.children, visit);
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  walk(node, (el) => pred(el) && hits.push(el));
  return hits;
}
function textOf(node: unknown): string {
  let out = '';
  const rec = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string' || typeof n === 'number') out += String(n);
    else if (Array.isArray(n)) n.forEach(rec);
    else if (isEl(n)) rec(n.props.children);
  };
  rec(node);
  return out;
}
function hasClass(el: El, cls: string): boolean {
  return typeof el.props.className === 'string' && el.props.className.split(' ').includes(cls);
}
function group(tree: unknown, label: string): El {
  const g = findAll(tree, (el) => el.props.role === 'group' && el.props['aria-label'] === label);
  expect(g, `group "${label}"`).toHaveLength(1);
  return g[0];
}
function pressedSegments(scope: unknown): El[] {
  return findAll(scope, (el) => el.type === 'button' && hasClass(el, 'is-pressed'));
}
function segmentByLabel(scope: unknown, label: string): El {
  const b = findAll(scope, (el) => el.type === 'button' && textOf(el) === label);
  expect(b, `segment "${label}"`).toHaveLength(1);
  return b[0];
}

describe('SinkConfigBody — Target segmented control (sink_target_segments)', () => {
  it('renders Debug/HTTP as .fab-tool-btn segments (not a native <select>)', () => {
    const tree = SinkConfigBody({ target: { kind: 'Debug' }, onChange: () => {} });
    expect(findAll(tree, (el) => el.type === 'select')).toHaveLength(0);
    const g = group(tree, 'Target');
    for (const label of ['Debug', 'HTTP']) {
      expect(hasClass(segmentByLabel(g, label), 'fab-tool-btn')).toBe(true);
    }
  });

  it('offers exactly two targets, Debug and HTTP, for every target kind (CHROME-04)', () => {
    // Phase 85 removed the Email target: the shipped app could never send mail.
    for (const target of [
      { kind: 'Debug' } as SinkTemplate,
      { kind: 'Http', url: 'http://x', method: 1 } as SinkTemplate,
    ]) {
      const g = group(SinkConfigBody({ target, onChange: () => {} }), 'Target');
      const labels = findAll(g, (el) => el.type === 'button').map((b) => textOf(b));
      expect(labels).toEqual(['Debug', 'HTTP']);
    }
  });

  it('keeps exactly one Target segment pressed (single_select_invariant)', () => {
    for (const target of [
      { kind: 'Debug' } as SinkTemplate,
      { kind: 'Http', url: '', method: 0 } as SinkTemplate,
    ]) {
      const g = group(SinkConfigBody({ target, onChange: () => {} }), 'Target');
      expect(pressedSegments(g)).toHaveLength(1);
    }
  });

  it('a Debug target reveals NO HTTP fields', () => {
    const tree = SinkConfigBody({ target: { kind: 'Debug' }, onChange: () => {} });
    expect(findAll(tree, (el) => el.type === 'input')).toHaveLength(0);
  });

});

describe('SinkConfigBody — HTTP fields + method (HttpMethod byte map)', () => {
  it('reveals a URL field and a GET..DELETE method segmented control', () => {
    const tree = SinkConfigBody({ target: { kind: 'Http', url: 'http://x', method: 0 }, onChange: () => {} });
    expect(findAll(tree, (el) => el.props.id === 'fab-sink-http-url')).toHaveLength(1);
    const g = group(tree, 'Method');
    for (const label of HTTP_METHODS) {
      expect(segmentByLabel(g, label)).toBeTruthy();
    }
  });

  it('maps GET=0..DELETE=4 and keeps exactly one method pressed', () => {
    HTTP_METHODS.forEach((label, byte) => {
      let got: SinkTemplate | null = null;
      const tree = SinkConfigBody({
        target: { kind: 'Http', url: 'http://x', method: 0 },
        onChange: (t) => (got = t),
      });
      const g = group(tree, 'Method');
      (segmentByLabel(g, label).props.onClick as () => void)();
      expect(got).toEqual({ kind: 'Http', url: 'http://x', method: byte });
    });
    // DELETE is byte 4; GET is byte 0.
    expect(HTTP_METHODS[0]).toBe('GET');
    expect(HTTP_METHODS[4]).toBe('DELETE');
    // Exactly one method pressed for a Http target on PATCH (byte 3).
    const g = group(
      SinkConfigBody({ target: { kind: 'Http', url: '', method: 3 }, onChange: () => {} }),
      'Method',
    );
    expect(pressedSegments(g)).toHaveLength(1);
    expect(textOf(pressedSegments(g)[0])).toBe('PATCH');
  });
});
