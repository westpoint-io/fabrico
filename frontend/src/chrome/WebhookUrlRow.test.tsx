import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY_LABELS, COPY_LABEL_MAX_CH, WebhookUrlRowView } from './WebhookUrlRow.tsx';
import type { CopyState } from './clipboardCopy.ts';

// WebhookUrlRowView is the pure presentational half (told url/copyState via props),
// invoked directly and walked in the node env. The hook wrapper's fetch + result
// timer are covered live in 39-08 e2e; the copy verdict itself is pinned by the
// node lock in clipboardCopy.test.ts (QA-01).

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
const button = (tree: unknown): El => findAll(tree, (el) => el.type === 'button')[0];

describe('WebhookUrlRowView — copy + availability (webhook_url_copy)', () => {
  const URL = 'http://127.0.0.1:8787/hook/src-3';

  it('shows the URL and a Copy button when available', () => {
    const tree = WebhookUrlRowView({ url: URL, copyState: 'idle', onCopy: () => {} });
    expect(textOf(tree)).toContain(URL);
    const b = button(tree);
    expect(textOf(b)).toBe('Copy');
    expect(b.props.disabled).toBe(false);
  });

  it('flips the button label to "Copied" while copied', () => {
    const b = button(WebhookUrlRowView({ url: URL, copyState: 'copied', onCopy: () => {} }));
    expect(textOf(b)).toBe('Copied');
  });

  // QA-01: the observed-failure word. Reachable only from a rejection, a
  // synchronous throw or a provably absent API, never from elapsed time.
  it('reads "Copy failed" when the write was observed to fail', () => {
    const b = button(WebhookUrlRowView({ url: URL, copyState: 'failed', onCopy: () => {} }));
    expect(textOf(b)).toBe('Copy failed');
  });

  // The in-flight state holds the idle label: nothing has happened yet, so the
  // button must not claim anything.
  it('holds the "Copy" label while the write is in flight', () => {
    const b = button(WebhookUrlRowView({ url: URL, copyState: 'copying', onCopy: () => {} }));
    expect(textOf(b)).toBe('Copy');
  });

  it('routes clicks to onCopy', () => {
    let copies = 0;
    (button(WebhookUrlRowView({ url: URL, copyState: 'idle', onCopy: () => copies++ })).props.onClick as () => void)();
    expect(copies).toBe(1);
  });

  it('shows a disabled "Webhook not ready" placeholder + disabled Copy when unavailable', () => {
    for (const url of [null, '']) {
      const tree = WebhookUrlRowView({ url, copyState: 'idle', onCopy: () => {} });
      expect(textOf(tree)).toContain('Webhook not ready');
      expect(button(tree).props.disabled).toBe(true);
    }
  });

  // LEGIBLE-01: the row is reused for the Endpoint card with a "POST URL" label.
  // Default stays "Webhook URL" so the Source call site is untouched.
  it('defaults the label to "Webhook URL" when no label prop is given', () => {
    const label = findAll(WebhookUrlRowView({ url: URL, copyState: 'idle', onCopy: () => {} }), (el) => el.type === 'label')[0];
    expect(textOf(label)).toBe('Webhook URL');
  });

  it('renders a custom label ("POST URL") when passed, value/placeholder unchanged', () => {
    const tree = WebhookUrlRowView({ url: URL, copyState: 'idle', onCopy: () => {}, label: 'POST URL' });
    const label = findAll(tree, (el) => el.type === 'label')[0];
    expect(textOf(label)).toBe('POST URL');
    // Value behaviour is untouched by the relabel.
    expect(textOf(tree)).toContain(URL);
    // The disabled placeholder path also keeps the custom label.
    const empty = WebhookUrlRowView({ url: null, copyState: 'idle', onCopy: () => {}, label: 'POST URL' });
    expect(textOf(findAll(empty, (el) => el.type === 'label')[0])).toBe('POST URL');
    expect(textOf(empty)).toContain('Webhook not ready');
  });
});

// ---------------------------------------------------------------------------
// The full states matrix (52-UI-SPEC States Matrix + Accessibility).
//
// Driven as a TABLE over all four copy states crossed with the available and the
// two unavailable URL cases, so a future edit cannot regress one cell quietly.
//
// The absence assertions are explicit `toBeUndefined()` rather than "not true",
// because a test that only checked for the PRESENCE of aria-busy/aria-disabled
// would pass on a component that set them in every state - which is exactly the
// bug that would take the button out of the tab order permanently and silence
// the polite announcement for the keyboard user the announcement exists for.

const COPY_STATES: readonly CopyState[] = ['idle', 'copying', 'copied', 'failed'];

describe('WebhookUrlRowView: the states matrix (52-UI-SPEC)', () => {
  const ROW_URL = 'http://127.0.0.1:8787/hook/src-3';
  const CASES: ReadonlyArray<{ url: string | null; available: boolean }> = [
    { url: ROW_URL, available: true },
    { url: null, available: false },
    { url: '', available: false },
  ];
  const view = (url: string | null, copyState: CopyState): unknown =>
    WebhookUrlRowView({ url, copyState, onCopy: () => {} });
  const styleOf = (el: El): Record<string, unknown> =>
    (el.props.style ?? {}) as Record<string, unknown>;

  it('labels every state from the frozen triad, holding "Copy" while in flight', () => {
    const expected: Record<CopyState, string> = {
      idle: 'Copy',
      copying: 'Copy',
      copied: 'Copied',
      failed: 'Copy failed',
    };
    // The triad is the button's ENTIRE vocabulary: pinned on the exported map so
    // a fourth word cannot be introduced without failing here.
    expect(COPY_LABELS).toEqual(expected);
    for (const { url } of CASES) {
      for (const s of COPY_STATES) {
        expect(textOf(button(view(url, s))), `${s} @ ${JSON.stringify(url)}`).toBe(expected[s]);
      }
    }
  });

  it('binds the REAL disabled attribute to URL absence alone, never to the in-flight window', () => {
    for (const { url, available } of CASES) {
      for (const s of COPY_STATES) {
        expect(button(view(url, s)).props.disabled, `${s} @ ${JSON.stringify(url)}`).toBe(
          !available,
        );
      }
    }
  });

  it('marks ONLY the in-flight window with aria-busy and aria-disabled', () => {
    for (const { url } of CASES) {
      for (const s of COPY_STATES) {
        const b = button(view(url, s));
        const where = `${s} @ ${JSON.stringify(url)}`;
        if (s === 'copying') {
          expect(b.props['aria-busy'], where).toBe(true);
          expect(b.props['aria-disabled'], where).toBe(true);
        } else {
          // ABSENT, not present-and-negative.
          expect(b.props['aria-busy'], `aria-busy leaked into ${where}`).toBeUndefined();
          expect(b.props['aria-disabled'], `aria-disabled leaked into ${where}`).toBeUndefined();
        }
      }
    }
  });

  it('is its own live region in every state, polite for a RESULT and off for the reset (A3)', () => {
    // A3 still holds: the attribute is present on the button in all four states,
    // so there is no hidden sibling, no extra row, and the region is established
    // before any content change rather than being torn down and rebuilt.
    //
    // What it must NOT do is announce the hold timer swapping `Copied` back to
    // `Copy`. That change is a visual reset, arrives 1.5s later with no user
    // action behind it, and told a screen-reader user nothing ("Copy failed"
    // then "Copy" on the failure path). Only a settled result is news.
    for (const { url } of CASES) {
      for (const s of COPY_STATES) {
        const where = `${s} @ ${JSON.stringify(url)}`;
        const live = button(view(url, s)).props['aria-live'];
        // Present in EVERY state - never dropped.
        expect(live, `the live region was torn down in ${where}`).toBeDefined();
        expect(live, where).toBe(s === 'copied' || s === 'failed' ? 'polite' : 'off');
      }
    }
  });

  it('reserves the widest label width, DERIVED from the label set rather than written (A8)', () => {
    // Recomputed here from COPY_LABELS rather than hardcoded, so the DERIVATION
    // itself is pinned: a future copy change moves both sides together, and a
    // regression to a loose numeric literal fails.
    const widest = Math.max(...Object.values(COPY_LABELS).map((l) => l.length));
    expect(COPY_LABEL_MAX_CH).toBe(widest);
    expect(widest).toBe('Copy failed'.length);
    for (const { url } of CASES) {
      for (const s of COPY_STATES) {
        const style = styleOf(button(view(url, s)));
        expect(style.minWidth, `${s} @ ${JSON.stringify(url)}`).toBe(`${widest}ch`);
        expect(style.whiteSpace, `${s} @ ${JSON.stringify(url)}`).toBe('nowrap');
      }
    }
  });

  it('keeps the neutral fab-tool-btn class in every state: no tint, no alert, no status row', () => {
    for (const { url } of CASES) {
      for (const s of COPY_STATES) {
        const tree = view(url, s);
        const where = `${s} @ ${JSON.stringify(url)}`;
        expect(button(tree).props.className, where).toBe('fab-tool-btn');
        // A failed clipboard write destroys nothing and diverges no state, so it
        // joins the polite tier, not the errorRow tier (52-UI-SPEC A2).
        const shouty = findAll(
          tree,
          (el) => el.props.role === 'alert' || el.props.role === 'status',
        );
        expect(shouty, `a live-region role leaked into ${where}`).toHaveLength(0);
        const tinted = findAll(tree, (el) =>
          JSON.stringify(el.props.style ?? {}).includes('destructive'),
        );
        expect(tinted, `a destructive tint leaked into ${where}`).toHaveLength(0);
      }
    }
  });

  it('renders no additional element and no additional text in any state', () => {
    for (const { url, available } of CASES) {
      // Identical element COUNT across all four states: no alert row, no status
      // row, no toast, no banner, and no layout consequence.
      const shapes = COPY_STATES.map((s) => findAll(view(url, s), () => true).length);
      expect(new Set(shapes).size, `element count differs across states @ ${JSON.stringify(url)}`).toBe(1);
      for (const s of COPY_STATES) {
        const body = available ? ROW_URL : 'Webhook not ready';
        expect(textOf(view(url, s)), `${s} @ ${JSON.stringify(url)}`).toBe(
          `Webhook URL${body}${COPY_LABELS[s]}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The copy path's SOURCE discipline (T-52-16 / A1, expressed as a standing test
// rather than a one-off grep in a summary).
//
// The single most dangerous regression available to this feature is a future
// edit that reintroduces the withdrawn 3000ms cap - because it would go green
// everywhere (a capped write still reports SOMETHING) while turning a slow but
// successful clipboard write into `Copy failed` with the URL already on the
// clipboard. The behaviour test for it lives in clipboardCopy.test.ts; this pins
// the same property structurally, across BOTH files of the live path, so a cap
// cannot be smuggled in through a code path no behaviour test happens to drive.

describe('the copy path has exactly ONE timer and no clock at all', () => {
  // Comments legitimately discuss the anti-patterns (that is where the hung-IPC
  // decision is recorded), so the discipline checks must measure real CODE.
  const stripComments = (s: string): string =>
    s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const read = (f: string): string =>
    stripComments(readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8'));
  const view = read('WebhookUrlRow.tsx');
  const machine = read('clipboardCopy.ts');
  const both = `${view}\n${machine}`;

  it('arms exactly one timer across the whole live path: the result hold', () => {
    // CALL sites only (`setTimeout(`), so the `ReturnType<typeof setTimeout>`
    // handle type is not miscounted as a second timer.
    const timers = both.match(/\bset(Timeout|Interval|Immediate)\s*\(/g) ?? [];
    expect(timers, `timer call sites: ${timers.join(', ')}`).toHaveLength(1);
    // And no timer is armed in the view at all: the machine owns the only one.
    expect(view).not.toMatch(/\bset(Timeout|Interval|Immediate)\s*\(/);
    // Exactly one arming through the injectable seam, and it is the result hold.
    expect(machine.match(/\bsetTimer\(/g) ?? []).toHaveLength(1);
    expect(machine).toMatch(/setTimer\([\s\S]*?COPY_RESULT_HOLD_MS\)/);
  });

  it('reads no clock and races no promise: `Copy failed` can never come from elapsed time', () => {
    for (const [name, src] of [
      ['WebhookUrlRow.tsx', view],
      ['clipboardCopy.ts', machine],
    ] as const) {
      expect(src, `${name} reads Date.now`).not.toContain('Date.now');
      expect(src, `${name} reads performance.now`).not.toContain('performance.now');
      expect(src, `${name} races a promise against a clock`).not.toContain('Promise.race');
      expect(src, `${name} races a promise against a clock`).not.toContain('Promise.any');
    }
  });

  it('uses the real `disabled` attribute for the availability guard and nothing else', () => {
    // `aria-disabled` (the in-flight guard) is deliberately NOT matched here: the
    // negative lookbehind is what makes this assertion about the REAL attribute,
    // the one that would drop focus to <body> mid-action.
    const bindings = view.match(/(?<!aria-)disabled=\{[^}]*\}/g) ?? [];
    expect(bindings).toEqual(['disabled={!available}']);
  });
});
