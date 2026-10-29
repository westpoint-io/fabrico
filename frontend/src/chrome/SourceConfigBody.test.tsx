import { describe, expect, it } from 'vitest';
import {
  SourceConfigBody,
  DEFAULT_TIMER_INTERVAL,
  MAX_TIMER_INTERVAL,
  sanitizeTimerInterval,
} from './SourceConfigBody.tsx';
import { encodeGridCommand } from '../protocol/decode.ts';
import { WebhookUrlRow } from './WebhookUrlRow.tsx';
import type { SourceTrigger } from '../protocol/decode.ts';

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
const noop = (): void => {};
const baseProps = (trigger: SourceTrigger) => ({ trigger, onChange: noop, node: 1, invoke: () => Promise.resolve(null) });
function segmentByLabel(scope: unknown, label: string): El {
  return findAll(scope, (el) => el.type === 'button' && textOf(el) === label)[0];
}

describe('SourceConfigBody — Trigger segments (source_trigger_segments)', () => {
  it('renders Webhook/Timer as .fab-tool-btn segments (not a native <select>)', () => {
    const tree = SourceConfigBody(baseProps({ kind: 'Webhook' }));
    expect(findAll(tree, (el) => el.type === 'select')).toHaveLength(0);
    expect(hasClass(segmentByLabel(tree, 'Webhook'), 'fab-tool-btn')).toBe(true);
    expect(hasClass(segmentByLabel(tree, 'Timer'), 'fab-tool-btn')).toBe(true);
  });

  it('keeps exactly one trigger segment pressed (single-select invariant)', () => {
    for (const trigger of [{ kind: 'Webhook' } as SourceTrigger, { kind: 'Timer', interval_ticks: 5 } as SourceTrigger]) {
      const g = findAll(SourceConfigBody(baseProps(trigger)), (el) => el.props.role === 'group' && el.props['aria-label'] === 'Trigger')[0];
      expect(findAll(g, (el) => el.type === 'button' && hasClass(el, 'is-pressed'))).toHaveLength(1);
    }
  });

  it('choosing Timer raises a Timer trigger seeded with the default interval', () => {
    let got: SourceTrigger | null = null;
    const tree = SourceConfigBody({ ...baseProps({ kind: 'Webhook' }), onChange: (t) => (got = t) });
    (segmentByLabel(tree, 'Timer').props.onClick as () => void)();
    expect(got).toEqual({ kind: 'Timer', interval_ticks: DEFAULT_TIMER_INTERVAL });
  });

  it('Webhook trigger hides the interval field; Timer reveals a numeric "Every … ticks" field', () => {
    expect(findAll(SourceConfigBody(baseProps({ kind: 'Webhook' })), (el) => el.props.id === 'fab-timer-interval')).toHaveLength(0);
    const timer = SourceConfigBody(baseProps({ kind: 'Timer', interval_ticks: 42 }));
    const input = findAll(timer, (el) => el.props.id === 'fab-timer-interval')[0];
    expect(input.props.type).toBe('text');
    // A string since review WR-B-01: the field shows typed text or the buffer's figure.
    expect(input.props.value).toBe('42');
    expect(hasClass(input, 'fab-field')).toBe(true);
    expect(textOf(timer)).toContain('ticks');
  });

  it('editing the interval raises a Timer trigger with the new count', () => {
    let got: SourceTrigger | null = null;
    const timer = SourceConfigBody({ ...baseProps({ kind: 'Timer', interval_ticks: 42 }), onChange: (t) => (got = t) });
    const input = findAll(timer, (el) => el.props.id === 'fab-timer-interval')[0];
    (input.props.onChange as (e: unknown) => void)({ currentTarget: { value: '120' } });
    expect(got).toEqual({ kind: 'Timer', interval_ticks: 120 });
  });

  it('sanitizes negative/fractional/empty interval to a valid integer >= 1 (F3)', () => {
    // The committed value must equal what gets encoded (an integer >= 1), never a raw
    // negative / fractional / empty that PostcardWriter.varintU would silently mangle.
    expect(sanitizeTimerInterval('-5')).toBe(1);
    expect(sanitizeTimerInterval('1.9')).toBe(1);
    expect(sanitizeTimerInterval('')).toBe(1);
    expect(sanitizeTimerInterval('0')).toBe(1);
    expect(sanitizeTimerInterval('abc')).toBe(1);
    // A well-formed positive integer rides through unchanged; a positive fraction floors.
    expect(sanitizeTimerInterval('120')).toBe(120);
    expect(sanitizeTimerInterval('3.7')).toBe(3);
  });

  it('the interval input commits the sanitized value on change (F3)', () => {
    // Driving the real input onChange with an invalid raw value raises a sanitized,
    // encodable interval (>= 1 integer) — so committed == displayed.
    let got: SourceTrigger | null = null;
    const timer = SourceConfigBody({ ...baseProps({ kind: 'Timer', interval_ticks: 42 }), onChange: (t) => (got = t) });
    const input = findAll(timer, (el) => el.props.id === 'fab-timer-interval')[0];
    (input.props.onChange as (e: unknown) => void)({ currentTarget: { value: '-5' } });
    expect(got).toEqual({ kind: 'Timer', interval_ticks: 1 });
  });

  it('the Every field is text with a numeric keyboard and no min or max (CHROME-14, D-08)', () => {
    // A number input draws the OS's light spin buttons on the dark panel (WebKitGTK); the
    // belt pace field's text-plus-inputMode shape draws none, and the sanitizer still guards.
    const timer = SourceConfigBody(baseProps({ kind: 'Timer', interval_ticks: 42 }));
    const input = findAll(timer, (el) => el.props.id === 'fab-timer-interval')[0];
    expect(input.type).toBe('input');
    expect(input.props.type).toBe('text');
    expect(input.props.inputMode).toBe('numeric');
    expect(input.props.min).toBeUndefined();
    expect(input.props.max).toBeUndefined();
  });

  it('typed text commits what sanitizeTimerInterval gives: 12.7 and abc (CHROME-14)', () => {
    for (const [raw, want] of [
      ['12.7', 12],
      ['abc', 1],
    ] as const) {
      let got: SourceTrigger | null = null;
      const timer = SourceConfigBody({ ...baseProps({ kind: 'Timer', interval_ticks: 42 }), onChange: (t) => (got = t) });
      const input = findAll(timer, (el) => el.props.id === 'fab-timer-interval')[0];
      (input.props.onChange as (e: unknown) => void)({ currentTarget: { value: raw } });
      expect(got, `typing ${JSON.stringify(raw)}`).toEqual({ kind: 'Timer', interval_ticks: want });
      expect(want).toBe(sanitizeTimerInterval(raw));
    }
  });

  // Phase 91 review CR-B-01 (T-91-24, UF-91-02): a pasted `Infinity`, `1e400` or 30 nines was
  // kept as `Infinity` or a figure past 2^53, and Apply's encode then looped forever or wrote a
  // number the host reads differently. Each raw must give a safe integer within the cap, and the
  // safety is checked BEFORE the encode, so a regressed sanitizer fails here instead of hanging.
  it('a pasted Infinity, 1e400 or 30 nines gives a safe integer at the cap, and Apply encodes it (CR-B-01)', () => {
    for (const raw of ['Infinity', '1e400', '9'.repeat(30), '1e21', '-Infinity', 'NaN']) {
      const n = sanitizeTimerInterval(raw);
      expect(Number.isSafeInteger(n), `sanitizeTimerInterval(${JSON.stringify(raw)}) = ${n} is a safe integer`).toBe(true);
      expect(n, `${JSON.stringify(raw)} is at least 1`).toBeGreaterThanOrEqual(1);
      expect(n, `${JSON.stringify(raw)} is at most the cap`).toBeLessThanOrEqual(MAX_TIMER_INTERVAL);
      const bytes = encodeGridCommand({ kind: 'Configure', node: 1, config: { kind: 'Source', trigger: { kind: 'Timer', interval_ticks: n } } });
      expect(bytes.length, `${JSON.stringify(raw)} encodes to a bounded frame`).toBeLessThan(32);
    }
    expect(sanitizeTimerInterval('Infinity'), 'a figure past the cap is the cap').toBe(MAX_TIMER_INTERVAL);
    expect(sanitizeTimerInterval('-Infinity'), 'a negative figure is 1').toBe(1);
    expect(MAX_TIMER_INTERVAL, 'the cap is the largest integer a JS number holds exactly').toBe(Number.MAX_SAFE_INTEGER);
    // Whole numbers below the cap are unchanged.
    expect(sanitizeTimerInterval(String(Number.MAX_SAFE_INTEGER - 1))).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it('hosts a WebhookUrlRow when the applied trigger is Webhook', () => {
    expect(
      findAll(SourceConfigBody({ ...baseProps({ kind: 'Webhook' }), committedTrigger: 'Webhook' }), (el) => el.type === WebhookUrlRow),
    ).toHaveLength(1);
  });
});

// DEMO-08 (plan 85-01, D-20, 72-UI-SPEC 3.1). The row shows a URL only when the trigger the
// HOST has folded is Webhook: a Source on Timer has no door, so a URL beside a Copy button
// would hand the user a 404. The row follows the COMMITTED trigger, never the typed buffer,
// exactly as the Route's POST URL row does.
describe('SourceConfigBody: the webhook URL row follows the applied trigger (DEMO-08)', () => {
  const rows = (tree: unknown): El[] => findAll(tree, (el) => el.type === WebhookUrlRow);

  it('committed Timer: the URL row is absent', () => {
    const tree = SourceConfigBody({
      ...baseProps({ kind: 'Timer', interval_ticks: 8 }),
      committedTrigger: 'Timer',
    });
    expect(rows(tree)).toHaveLength(0);
  });

  it('committed Webhook: the URL row renders, keyed on the committed kind', () => {
    const found = rows(SourceConfigBody({ ...baseProps({ kind: 'Webhook' }), committedTrigger: 'Webhook' }));
    expect(found).toHaveLength(1);
    expect(found[0].props.refreshKey).toBe('Webhook');
  });

  it('committed Webhook, buffer typed to Timer (unapplied): the row stays', () => {
    const found = rows(
      SourceConfigBody({ ...baseProps({ kind: 'Timer', interval_ticks: 60 }), committedTrigger: 'Webhook' }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].props.refreshKey).toBe('Webhook');
  });

  it('committed Timer, buffer typed to Webhook (unapplied): the row stays absent', () => {
    const tree = SourceConfigBody({ ...baseProps({ kind: 'Webhook' }), committedTrigger: 'Timer' });
    expect(rows(tree)).toHaveLength(0);
  });
});

// Phase 91 review WR-B-01: THE FIELD HOLDS WHAT THE USER TYPES. The field is controlled, and it
// used to show the sanitized number after every change, so `12.` snapped back to `12` and the
// next `7` made `127`, a stray letter reset the field to 1, and a cleared field could not be
// typed into (`30` read `130`). The rig below types the way a browser does: one key at a time,
// each change's text being what the field showed plus that key, the body re-rendered from the
// state its callbacks set after each key (the `beltTyped` pattern ConfigPanel holds).
describe('SourceConfigBody: the Every field holds the typed text, one keystroke at a time (WR-B-01)', () => {
  type Key = string | 'Backspace' | 'SelectAll';
  function rig(start: number) {
    let interval = start;
    let typed: string | null = null;
    let selected = false;
    const render = () =>
      SourceConfigBody({
        ...baseProps({ kind: 'Timer', interval_ticks: interval }),
        typed,
        onTyped: (t: string | null) => {
          typed = t;
        },
        onChange: (t: SourceTrigger) => {
          if (t.kind === 'Timer') interval = t.interval_ticks;
        },
      });
    const input = (): El => findAll(render(), (el) => el.props.id === 'fab-timer-interval')[0];
    return {
      press(keys: readonly Key[]) {
        for (const k of keys) {
          if (k === 'SelectAll') {
            selected = true;
            continue;
          }
          const shown = selected ? '' : String(input().props.value);
          selected = false;
          const next = k === 'Backspace' ? shown.slice(0, -1) : shown + k;
          (input().props.onChange as (e: unknown) => void)({ currentTarget: { value: next } });
        }
      },
      blur() {
        (input().props.onBlur as (() => void) | undefined)?.();
      },
      shown: () => String(input().props.value),
      committed: () => interval,
    };
  }
  const keys = (s: string): string[] => [...s];

  it('12.7 typed key by key shows 12.7 (never 127), commits 12, and shows 12 once the field is left', () => {
    const r = rig(60);
    r.press(['SelectAll', ...keys('12.7')]);
    expect(r.shown(), 'the field shows what was typed').toBe('12.7');
    expect(r.committed(), 'Apply would commit the whole part').toBe(12);
    r.blur();
    expect(r.shown(), 'leaving the field shows what Apply commits').toBe('12');
  });

  it('1.5 shows 1.5 (never 15) and commits 1', () => {
    const r = rig(60);
    r.press(['SelectAll', ...keys('1.5')]);
    expect(r.shown()).toBe('1.5');
    expect(r.committed()).toBe(1);
  });

  it('clearing 60 then typing 30 gives 30 (never 130)', () => {
    const r = rig(60);
    r.press(['Backspace', 'Backspace']);
    expect(r.shown(), 'a cleared field stays empty').toBe('');
    r.press(keys('30'));
    expect(r.shown()).toBe('30');
    expect(r.committed()).toBe(30);
  });

  it('a stray letter stays on screen and Backspace gives the old value back', () => {
    const r = rig(60);
    r.press(['x']);
    expect(r.shown(), 'the letter is shown, the value is not reset under the caret').toBe('60x');
    r.press(['Backspace']);
    expect(r.shown()).toBe('60');
    expect(r.committed()).toBe(60);
  });

  it('a segment press drops the typed text, so the field shows the buffer again', () => {
    let typed: string | null = 'abc';
    const tree = SourceConfigBody({
      ...baseProps({ kind: 'Timer', interval_ticks: 5 }),
      typed,
      onTyped: (t: string | null) => {
        typed = t;
      },
    });
    (segmentByLabel(tree, 'Webhook').props.onClick as () => void)();
    expect(typed).toBeNull();
  });
});
