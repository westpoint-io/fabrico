// LabelConfigBody.test.tsx (phase 76, plan 76-02, SHAPE-10, D-04, D-06) - the label
// panel's Text field.
//
// The vitest env is `node` (no DOM). `LabelConfigBody` is a HOOK-FREE pure function, so it
// is invoked directly and the returned `{ type, props }` descriptors are walked, exactly
// like `RouteConfigBody.test.tsx`.

import { describe, expect, it } from 'vitest';
import {
  LABEL_MAX_H,
  LABEL_MAX_W,
  LABEL_SIZE_HINT,
  LABEL_TEXT_FIELD_ID,
  LABEL_TEXT_HINT,
  LabelConfigBody,
  MAX_LABEL_BYTES,
  labelTextDispatchable,
  labelTextError,
  labelTextMessage,
  labelTextOverage,
  type LabelConfig,
} from './LabelConfigBody.tsx';

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (!isEl(n)) return;
    if (pred(n)) hits.push(n);
    visit(n.props.children);
  };
  visit(node);
  return hits;
}
function textOf(node: unknown): string {
  let out = '';
  const rec = (n: unknown): void => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') {
      out += String(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(rec);
      return;
    }
    if (isEl(n)) rec(n.props.children);
  };
  rec(node);
  return out;
}

const CONFIG: LabelConfig = { kind: 'Label', text: 'Order intake', colour: 3, w: 6, h: 2 };

/** Render the body and return its one textarea and the callback's calls. */
function render(config: LabelConfig): { tree: unknown; field: El; calls: LabelConfig[] } {
  const calls: LabelConfig[] = [];
  const tree = LabelConfigBody({ config, onChange: (c) => calls.push(c) });
  const fields = findAll(tree, (el) => el.type === 'textarea');
  expect(fields, 'the body renders exactly one textarea').toHaveLength(1);
  return { tree, field: fields[0], calls };
}

describe('LabelConfigBody - the Text field (SHAPE-10, D-04)', () => {
  it('shows the committed words in a labelled, hinted textarea', () => {
    const { tree, field } = render(CONFIG);
    expect(field.props.id).toBe(LABEL_TEXT_FIELD_ID);
    expect(field.props.value).toBe('Order intake');
    expect(field.props.className).toBe('fab-field');
    const labels = findAll(tree, (el) => el.type === 'label');
    expect(labels).toHaveLength(1);
    expect(labels[0].props.htmlFor, 'the label names the field').toBe(LABEL_TEXT_FIELD_ID);
    expect(textOf(labels[0])).toBe('Text');
    const hintId = field.props['aria-describedby'] as string;
    const hint = findAll(tree, (el) => el.props.id === hintId);
    expect(hint, 'the field is described by its hint').toHaveLength(1);
    expect(textOf(hint[0])).toBe(LABEL_TEXT_HINT);
    expect(LABEL_TEXT_HINT).toBe('Shown on the board. Lines wrap to fit the label.');
  });

  it('typing changes the text ONLY and passes colour, width and depth through unchanged', () => {
    const { field, calls } = render(CONFIG);
    const onChange = field.props.onChange as (e: { currentTarget: { value: string } }) => void;
    onChange({ currentTarget: { value: 'Dispatch' } });
    expect(calls).toEqual([{ kind: 'Label', text: 'Dispatch', colour: 3, w: 6, h: 2 }]);
  });

  it('keeps the user line breaks verbatim: nothing is trimmed or normalised on the way in', () => {
    const { field, calls } = render({ ...CONFIG, text: '' });
    const onChange = field.props.onChange as (e: { currentTarget: { value: string } }) => void;
    onChange({ currentTarget: { value: '  Line one\nLine two  ' } });
    expect(calls[0].text).toBe('  Line one\nLine two  ');
  });

  it('is three rows, at least two touch targets tall, and resizes vertically only', () => {
    const { field } = render(CONFIG);
    expect(field.props.rows).toBe(3);
    const style = field.props.style as Record<string, unknown>;
    expect(style.minHeight).toBe(88);
    expect(style.resize).toBe('vertical');
    expect(style.width).toBe('100%');
  });
});

// ── task 2: the text bound (SHAPE-13 write half, 76-UI-SPEC 5.5) ─────────────────────────

describe('the label text bound - over-length is stated, Apply waits, nothing is cut', () => {
  const withText = (text: string): LabelConfig => ({ ...CONFIG, text });
  const bytes = (s: string): number => new TextEncoder().encode(s).length;

  it('at exactly the bound in ASCII there is no error and the config is dispatchable', () => {
    const text = 'a'.repeat(MAX_LABEL_BYTES);
    expect(labelTextOverage(text)).toBe(0);
    expect(labelTextError(withText(text))).toBeNull();
    expect(labelTextDispatchable(withText(text))).toBe(true);
  });

  it('eight bytes over reads "too long by 8 characters." and is not dispatchable', () => {
    const text = 'a'.repeat(MAX_LABEL_BYTES + 8);
    expect(labelTextError(withText(text))).toBe('That text is too long by 8 characters.');
    expect(labelTextDispatchable(withText(text))).toBe(false);
  });

  it('one byte over is singular: "too long by 1 character."', () => {
    expect(labelTextError(withText('a'.repeat(MAX_LABEL_BYTES + 1)))).toBe(
      'That text is too long by 1 character.',
    );
    expect(labelTextMessage(1)).toBe('That text is too long by 1 character.');
    expect(labelTextMessage(2)).toBe('That text is too long by 2 characters.');
  });

  it('counts CHARACTERS removed from the end, not bytes, for multibyte text', () => {
    // One three-byte character past an ASCII text one byte under the bound: 514 bytes, two
    // bytes over, but removing ONE character fits it, so N is 1, not 2.
    const cjkTail = `${'a'.repeat(MAX_LABEL_BYTES - 1)}\u6ce8`;
    expect(bytes(cjkTail)).toBe(MAX_LABEL_BYTES + 2);
    expect(labelTextOverage(cjkTail)).toBe(1);
    // Two-byte characters: 257 of them is 514 bytes; one removed fits.
    expect(labelTextOverage('\u00e9'.repeat(MAX_LABEL_BYTES / 2 + 1))).toBe(1);
    // 260 of them is 520 bytes; four removed fit.
    expect(labelTextOverage('\u00e9'.repeat(MAX_LABEL_BYTES / 2 + 4))).toBe(4);
    // A character outside the BMP (four UTF-8 bytes, two UTF-16 units) counts as ONE.
    const astral = `${'a'.repeat(MAX_LABEL_BYTES)}\u{1F600}`;
    expect(labelTextOverage(astral)).toBe(1);
    expect(labelTextError(withText(astral))).toBe('That text is too long by 1 character.');
  });

  it('says nothing about any non-Label config', () => {
    expect(labelTextError({ kind: 'Endpoint', path: '/x' })).toBeNull();
    expect(labelTextDispatchable({ kind: 'Endpoint', path: '/x' })).toBe(true);
    expect(labelTextError(null)).toBeNull();
    expect(labelTextDispatchable(null)).toBe(true);
  });

  it('the field carries NO maxLength: it would count UTF-16 units, not bytes', () => {
    const { field } = render(withText('a'.repeat(MAX_LABEL_BYTES + 8)));
    expect(field.props.maxLength).toBeUndefined();
    expect(field.props.value, 'nothing typed is cut on the way in').toBe('a'.repeat(MAX_LABEL_BYTES + 8));
  });
});

// ── plan 76-03: the colour swatches and the size steppers (SHAPE-12, D-04, D-05) ─────────

describe('the label colour swatches (SHAPE-12, D-05, UI-SPEC 5.2)', () => {
  const swatches = (tree: unknown): El[] =>
    findAll(tree, (el) => el.type === 'button' && String(el.props.className ?? '').includes('fab-swatch'));

  it('six swatches in byte order, named Sand to Clay, the chosen one pressed', () => {
    const { tree } = render(CONFIG);
    const s = swatches(tree);
    expect(s.map((b) => b.props['aria-label'])).toEqual(['Sand', 'Stone', 'Moss', 'Lilac', 'Rose', 'Clay']);
    expect(s.map((b) => b.props.title), 'the title repeats the name').toEqual([
      'Sand',
      'Stone',
      'Moss',
      'Lilac',
      'Rose',
      'Clay',
    ]);
    expect(s.map((b) => b.props['aria-pressed'])).toEqual([false, false, false, true, false, false]);
    expect(s.every((b) => b.props.type === 'button'), 'never a submit button').toBe(true);
    expect(String(s[3].props.className)).toContain('is-pressed');
    expect(String(s[0].props.className)).not.toContain('is-pressed');
  });

  it('each swatch holds a square filled from its --fab-label-* token, never a hex', () => {
    const { tree } = render(CONFIG);
    const names = ['sand', 'stone', 'moss', 'lilac', 'rose', 'clay'];
    expect(swatches(tree), 'six swatches, so the walk below is not vacuous').toHaveLength(6);
    swatches(tree).forEach((b, i) => {
      const chips = findAll(b.props.children, (el) => el.type === 'span');
      expect(chips).toHaveLength(1);
      const style = chips[0].props.style as Record<string, unknown>;
      expect(style.background).toBe(`var(--fab-label-${names[i]})`);
      expect([style.width, style.height]).toEqual([24, 24]);
    });
  });

  it('the name beside Colour reads the chosen colour, and the group is labelled by Colour', () => {
    const { tree } = render(CONFIG);
    const name = findAll(tree, (el) => el.props.id === 'fab-label-colour-name');
    expect(name).toHaveLength(1);
    expect(textOf(name[0])).toBe('Lilac');
    const groups = findAll(tree, (el) => el.props.role === 'group');
    const colourGroup = groups.find((g) => swatches(g).length === 6);
    expect(colourGroup, 'the swatches sit in one group').toBeDefined();
    const labelId = colourGroup!.props['aria-labelledby'] as string;
    const label = findAll(tree, (el) => el.props.id === labelId);
    expect(textOf(label[0])).toBe('Colour');
  });

  it('a swatch click changes the colour ONLY', () => {
    const calls: LabelConfig[] = [];
    const tree = LabelConfigBody({ config: CONFIG, onChange: (c) => calls.push(c) });
    (swatches(tree)[5].props.onClick as () => void)();
    expect(calls).toEqual([{ ...CONFIG, colour: 5 }]);
  });
});

describe('the label size steppers (SHAPE-12, D-04, UI-SPEC 5.3)', () => {
  const button = (tree: unknown, name: string): El => {
    const hits = findAll(tree, (el) => el.type === 'button' && el.props['aria-label'] === name);
    expect(hits, `exactly one button named ${name}`).toHaveLength(1);
    return hits[0];
  };
  const PLACED: LabelConfig = { kind: 'Label', text: '', colour: 0, w: 4, h: 1 };

  it('Increase width from 4 gives 5 and leaves depth, text and colour alone', () => {
    const calls: LabelConfig[] = [];
    const tree = LabelConfigBody({ config: PLACED, onChange: (c) => calls.push(c) });
    (button(tree, 'Increase width').props.onClick as () => void)();
    (button(tree, 'Increase depth').props.onClick as () => void)();
    (button(tree, 'Decrease width').props.onClick as () => void)();
    expect(calls).toEqual([
      { ...PLACED, w: 5 },
      { ...PLACED, h: 2 },
      { ...PLACED, w: 3 },
    ]);
  });

  it('the readouts show the buffer size in output elements the buttons are described by', () => {
    const tree = LabelConfigBody({ config: CONFIG, onChange: () => {} });
    const outs = findAll(tree, (el) => el.type === 'output');
    expect(outs.map((o) => [o.props.id, textOf(o)])).toEqual([
      ['fab-label-width', '6'],
      ['fab-label-depth', '2'],
    ]);
    expect(button(tree, 'Increase width').props['aria-describedby']).toBe('fab-label-width');
    expect(button(tree, 'Decrease depth').props['aria-describedby']).toBe('fab-label-depth');
  });

  it('the minus shows U+2212 and the plus shows +', () => {
    const tree = LabelConfigBody({ config: CONFIG, onChange: () => {} });
    expect(textOf(button(tree, 'Decrease width'))).toBe('\u2212');
    expect(textOf(button(tree, 'Increase depth'))).toBe('+');
  });

  it('minus is disabled at 1; plus is disabled at the caps, 16 wide and 8 deep', () => {
    const small = LabelConfigBody({ config: { ...PLACED, w: 1, h: 1 }, onChange: () => {} });
    expect(button(small, 'Decrease width').props.disabled).toBe(true);
    expect(button(small, 'Decrease depth').props.disabled).toBe(true);
    expect(button(small, 'Increase width').props.disabled).toBe(false);
    const big = LabelConfigBody({ config: { ...PLACED, w: LABEL_MAX_W, h: LABEL_MAX_H }, onChange: () => {} });
    expect([LABEL_MAX_W, LABEL_MAX_H]).toEqual([16, 8]);
    expect(button(big, 'Increase width').props.disabled).toBe(true);
    expect(button(big, 'Increase depth').props.disabled).toBe(true);
    expect(button(big, 'Decrease width').props.disabled).toBe(false);
  });

  it('the hint is the sentence built from the two caps', () => {
    expect(LABEL_SIZE_HINT).toBe(`In cells. Up to ${LABEL_MAX_W} wide and ${LABEL_MAX_H} deep.`);
    expect(LABEL_SIZE_HINT).toBe('In cells. Up to 16 wide and 8 deep.');
    const tree = LabelConfigBody({ config: CONFIG, onChange: () => {} });
    expect(findAll(tree, (el) => textOf(el) === LABEL_SIZE_HINT && el.type === 'p')).toHaveLength(1);
  });

  it('keeps the order Text, Colour, Size (UI-SPEC 5.1)', () => {
    const tree = LabelConfigBody({ config: CONFIG, onChange: () => {} });
    const all = textOf(tree);
    expect(all.indexOf('Text')).toBeLessThan(all.indexOf('Colour'));
    expect(all.indexOf('Colour')).toBeLessThan(all.indexOf('Size'));
  });
});
