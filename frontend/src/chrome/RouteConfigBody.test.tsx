// RouteConfigBody.test.tsx (SERVE-05, 72-10) - the Path field and its client gate.
//
// The vitest env is `node` (no DOM, no testing-library - the repo's zero-new-packages
// discipline). `RouteConfigBody` is a HOOK-FREE pure function, so it is invoked
// directly and the returned `{ type, props }` descriptors are walked, exactly like
// `PortsSection.test.tsx` and `DeleteControl.test.tsx`.
//
// WHAT THIS FILE COVERS THAT `ConfigPanel.test.tsx` DOES NOT. That file asserts the
// panel WIRES the gate: Apply disables, one alert row appears, the sentence is the
// right one. This file asserts the gate's own rules and copy, including the boundary
// cases a panel-level suite would need a fixture per row to reach - and the ORDER the
// rules fire in, which is load-bearing and which nothing else can see.

import { describe, expect, it } from 'vitest';
import {
  MAX_ENDPOINT_PATH_BYTES,
  PATH_FIELD_ID,
  PATH_HINT,
  RouteConfigBody,
  routePathDispatchable,
  routePathError,
  routePathMessage,
  routePathRefusal,
  type RouteNeighbour,
} from './RouteConfigBody.tsx';
import type { MachineConfig } from '../protocol/decode.ts';

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

const NONE: readonly RouteNeighbour[] = [];
const AT = (path: string, cell_x = 14, cell_y = 6): RouteNeighbour => ({
  node: 7,
  path,
  cell_x,
  cell_y,
});

describe('routePathRefusal - the four rules (R-47)', () => {
  it('accepts an ordinary path against an empty board', () => {
    expect(routePathRefusal('/orders', NONE)).toBeNull();
  });

  it('accepts the shipped placement default, so a fresh Route is never in refusal', () => {
    // `add_endpoint` mints `/route-<n>`, the smallest number no Route holds (phase 91,
    // D-13). A default the gate refused would put a destructive row and a dead Apply on
    // every freshly placed Route.
    expect(routePathRefusal('/route-1', NONE)).toBeNull();
  });

  it('accepts every byte of the unreserved set, so the alphabet is not narrower than the core\'s', () => {
    // Mirrors `fabrico_core::edit::is_unreserved_path_byte`. A client alphabet
    // NARROWER than the core's silently refuses paths the engine would take, which is
    // the failure mode a courtesy gate is most likely to have and the one nobody
    // notices: the user just cannot type something, with a sentence that sounds right.
    expect(routePathRefusal('/aZ0-._~/x', NONE)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['no leading slash', 'orders'],
    ['a bare slash', '/'],
    ['two leading slashes', '//orders'],
    ['three leading slashes', '///orders'],
    ['nothing but leading slashes', '//'],
  ])('refuses %s with the structure tag', (_label, path) => {
    expect(routePathRefusal(path, NONE)).toEqual({ tag: 'structure' });
  });

  it('refuses a REPEATED leading slash, which is CR-01 mirrored from the core', () => {
    // THE DEFECT THIS MIRRORS, stated as the user met it. `/` is in the unreserved set,
    // so `//orders` passed every rule this gate and the core had; rule 4 compares raw
    // strings, so it was not a duplicate of `/orders` either. But the host publishes
    // each Route's key through `endpoint_route_key`, which trims ALL leading slashes,
    // so both paths keyed as `/orders` and the higher node id silently won. The
    // shadowed Route's own config card then showed a POST URL that ran the OTHER
    // Route's Handler, with no 404 and no refusal anywhere.
    //
    // The gate's own contract is that it asks THE SAME QUESTION OF THE SAME STRING as
    // `fabrico_core::edit::endpoint_path_is_valid`. A core that refused this while the
    // panel accepted it would put the user back where they started: typing a path,
    // pressing Apply, and meeting a causeless host refusal.
    expect(routePathRefusal('//orders', NONE)).toEqual({ tag: 'structure' });
    // And it is refused even when NO other Route holds the address it would collide
    // with, because the rule is about the string and not about the board.
    expect(routePathRefusal('//orders', [AT('/invoices')])).toEqual({ tag: 'structure' });
  });

  it('accepts INTERIOR slashes, because J-5 ruled multi-segment paths legal', () => {
    // The other side of the same rule, and it is a RULING rather than an afterthought.
    // Only the LEADING slashes are normalized away by the host key, so an interior
    // empty segment collides with nothing. A mirror spelled `path.includes('//')`
    // would have closed CR-01 and refused `/orders/new/id` in the same line.
    expect(routePathRefusal('/orders/new', NONE)).toBeNull();
    expect(routePathRefusal('/orders/new/id', NONE)).toBeNull();
    expect(routePathRefusal('/a//b', NONE)).toBeNull();
  });

  it.each([
    ['a space', '/my orders'],
    ['a percent sequence', '/%2e%2e'],
    ['a query string', '/orders?id=1'],
    ['a fragment', '/orders#top'],
    ['a non-ASCII letter', '/orders/é'],
  ])('refuses %s with the charset tag', (_label, path) => {
    expect(routePathRefusal(path, NONE)).toEqual({ tag: 'charset' });
  });

  it('refuses a percent sequence rather than decoding it and then judging (traversal)', () => {
    // The rule is an ALPHABET, and refusing an alphabet is total in a way that
    // decode-then-judge is not. `%2e%2e` is `..` decoded, and a gate that decoded
    // first would have to get the traversal check right; this one never sees a `..`
    // because `%` is simply not a byte a path may carry.
    expect(routePathRefusal('/%2e%2e/hook', NONE)).toEqual({ tag: 'charset' });
    expect(routePathRefusal('/../hook', NONE)).toBeNull(); // `.` and `/` ARE unreserved
  });

  it('accepts a path of exactly the bound and refuses one byte over it', () => {
    const at = `/${'a'.repeat(MAX_ENDPOINT_PATH_BYTES - 1)}`;
    expect(at.length).toBe(MAX_ENDPOINT_PATH_BYTES);
    expect(routePathRefusal(at, NONE)).toBeNull();
    expect(routePathRefusal(`${at}a`, NONE)).toEqual({ tag: 'too-long', over: 1 });
  });

  it('reports the OVERAGE, and the overage grows with the path', () => {
    const over = 37;
    const path = `/${'a'.repeat(MAX_ENDPOINT_PATH_BYTES - 1 + over)}`;
    expect(routePathRefusal(path, NONE)).toEqual({ tag: 'too-long', over });
  });

  it('refuses a duplicate and NAMES the owner by cell', () => {
    expect(routePathRefusal('/orders', [AT('/orders', 14, 6)])).toEqual({
      tag: 'duplicate',
      cell: '(14,6)',
    });
  });

  it('does not refuse merely because other Routes exist', () => {
    expect(routePathRefusal('/orders', [AT('/invoices'), AT('/route-9', 3, 3)])).toBeNull();
  });

  it('names the FIRST owner when a board somehow carries two, rather than guessing', () => {
    // Unreachable through the core, which refuses the second claim - so this is a
    // totality belt on a board loaded from a file written by an older build. Naming
    // one real cell beats naming none.
    expect(routePathRefusal('/orders', [AT('/orders', 1, 1), AT('/orders', 9, 9)])).toEqual({
      tag: 'duplicate',
      cell: '(1,1)',
    });
  });

  it('matches a duplicate EXACTLY, never by prefix or case', () => {
    // `/order` must not collide with `/orders`, and `/Orders` is a different address:
    // the host route map keys on the stored string, so a client gate that folded case
    // would refuse a path the engine would happily take.
    expect(routePathRefusal('/order', [AT('/orders')])).toBeNull();
    expect(routePathRefusal('/orders/x', [AT('/orders')])).toBeNull();
    expect(routePathRefusal('/Orders', [AT('/orders')])).toBeNull();
  });

  it('checks CHARSET before LENGTH, which is what makes the overage honest', () => {
    // The over-length sentence counts CHARACTERS while the bound counts BYTES. They
    // agree only for the ASCII alphabet the charset rule enforces, so a non-ASCII path
    // must never reach the length rule - it would report an overage in units the
    // user's path does not use. This case drives a path that is BOTH over the bound
    // and non-ASCII, and asserts which rule answers.
    const path = `/${'é'.repeat(MAX_ENDPOINT_PATH_BYTES)}`;
    expect(new TextEncoder().encode(path).length).toBeGreaterThan(MAX_ENDPOINT_PATH_BYTES);
    expect(routePathRefusal(path, NONE)).toEqual({ tag: 'charset' });
  });

  it('checks STRUCTURE before everything, so a cleared field says the plain thing', () => {
    // An empty field is also, trivially, not a duplicate and not too long. The
    // sentence a user meets most often should be the one about the field they just
    // cleared, not a downstream consequence of it.
    expect(routePathRefusal('', [AT('')])).toEqual({ tag: 'structure' });
  });
});

describe('routePathMessage - the copy (72-UI-SPEC 8.2 plus R-18)', () => {
  it('writes each refusal with its contract sentence, character for character', () => {
    expect(routePathMessage({ tag: 'structure' })).toBe('A path starts with a single / and cannot be empty.');
    expect(routePathMessage({ tag: 'charset' })).toBe(
      'That path has a character a URL cannot carry.',
    );
    expect(routePathMessage({ tag: 'too-long', over: 4 })).toBe(
      'That path is too long by 4 characters.',
    );
    expect(routePathMessage({ tag: 'duplicate', cell: '(14,6)' })).toBe(
      'That path is already used by the Route at (14,6).',
    );
  });

  it('says "1 character" and not "1 characters"', () => {
    // The one-character case is the most likely one a user meets, because they get
    // there by typing one byte too many.
    expect(routePathMessage({ tag: 'too-long', over: 1 })).toBe(
      'That path is too long by 1 character.',
    );
  });

  it('never states the BOUND, only the overage', () => {
    // A restated figure is a second source of truth. 68-UI-SPEC FINDING 1 is the
    // worked example of what that costs, and this is the arm that holds it shut.
    const sentence = routePathMessage({ tag: 'too-long', over: 4 });
    expect(sentence).not.toContain(String(MAX_ENDPOINT_PATH_BYTES));
  });

  it('writes every sentence in the house voice: terminal period, no apology, no em dash', () => {
    const all = [
      routePathMessage({ tag: 'structure' }),
      routePathMessage({ tag: 'charset' }),
      routePathMessage({ tag: 'too-long', over: 4 }),
      routePathMessage({ tag: 'duplicate', cell: '(14,6)' }),
    ];
    for (const s of all) {
      expect(s.endsWith('.'), `"${s}" ends with a period`).toBe(true);
      expect(s.toLowerCase().includes('sorry'), `"${s}" does not apologise`).toBe(false);
      expect(s.toLowerCase().includes('please'), `"${s}" does not say please`).toBe(false);
      expect(s.includes('—'), `"${s}" has no em dash`).toBe(false);
      expect(s.includes('–'), `"${s}" has no en dash`).toBe(false);
      expect(s[0], `"${s}" is sentence case`).toBe(s[0].toUpperCase());
    }
  });

  it('names the OWNER in the panel row, which the host tag structurally cannot (D-13)', () => {
    // The split, stated as an assertion. `REFUSAL_COPY.DuplicatePath` is a Record over
    // a closed union with no host string interpolated, so the tag names no Route. The
    // panel does, because it already polls the board. The tag carries the AUTHORITY,
    // this row carries the NAME.
    expect(routePathMessage({ tag: 'duplicate', cell: '(3,9)' })).toContain('(3,9)');
  });
});

describe('routePathDispatchable / routePathError - the panel-facing shape', () => {
  const ROUTE = (path: string): MachineConfig => ({ kind: 'Endpoint', path });

  it('answers TRUE for a null config and for every non-Route kind', () => {
    // The `beltRunDispatchable` shape: the predicate guards the kind so no caller has
    // to. A caller that had to remember would eventually forget, and the failure would
    // be a Factory whose Apply was silently blocked by a rule about addresses.
    expect(routePathDispatchable(null, NONE)).toBe(true);
    expect(routePathDispatchable({ kind: 'Factory', source: '' }, NONE)).toBe(true);
    expect(routePathDispatchable({ kind: 'Belt', ticks_per_slot: 4 }, NONE)).toBe(true);
    expect(routePathError(null, NONE)).toBeNull();
    expect(routePathError({ kind: 'Factory', source: '' }, NONE)).toBeNull();
  });

  it('answers FALSE with the matching sentence for each refusal', () => {
    expect(routePathDispatchable(ROUTE(''), NONE)).toBe(false);
    expect(routePathError(ROUTE(''), NONE)).toBe('A path starts with a single / and cannot be empty.');
    expect(routePathDispatchable(ROUTE('/orders'), [AT('/orders')])).toBe(false);
    expect(routePathError(ROUTE('/orders'), [AT('/orders')])).toBe(
      'That path is already used by the Route at (14,6).',
    );
  });

  it('answers TRUE with no sentence for a legal unclaimed path', () => {
    expect(routePathDispatchable(ROUTE('/orders'), [AT('/invoices')])).toBe(true);
    expect(routePathError(ROUTE('/orders'), [AT('/invoices')])).toBeNull();
  });

  it('agrees with itself: a sentence exists exactly when Apply is blocked', () => {
    // The two are separate exports read by separate call sites (the button's
    // `disabled` and the alert row), so a drift between them would show the user a
    // destructive row above a live Apply, or a dead Apply with no reason given.
    for (const path of ['', '/', 'x', '/ok', '/bad path', `/${'a'.repeat(2000)}`]) {
      for (const others of [NONE, [AT('/ok')]]) {
        const blocked = !routePathDispatchable(ROUTE(path), others);
        expect(routePathError(ROUTE(path), others) !== null, `path ${JSON.stringify(path)}`).toBe(
          blocked,
        );
      }
    }
  });
});

describe('RouteConfigBody - the rendered field', () => {
  const body = (path: string, onChange: (p: string) => void = () => {}): unknown =>
    RouteConfigBody({ path, onChange });

  it('renders exactly one label, one text input and one hint', () => {
    const tree = body('/orders');
    expect(findAll(tree, (el) => el.type === 'label')).toHaveLength(1);
    const inputs = findAll(tree, (el) => el.type === 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].props.type).toBe('text');
    expect(findAll(tree, (el) => el.type === 'p')).toHaveLength(1);
    // The block's whole visible TEXT. The field's value is an attribute, not a text
    // child, so it is correctly absent here - which is also what makes this an exact
    // equality rather than a `toContain`.
    expect(textOf(tree)).toBe(`Path${PATH_HINT}`);
  });

  it('labels the field "Path" and binds the label to it', () => {
    const tree = body('/orders');
    const label = findAll(tree, (el) => el.type === 'label')[0];
    expect(textOf(label)).toBe('Path');
    expect(label.props.htmlFor).toBe(PATH_FIELD_ID);
    expect(findAll(tree, (el) => el.type === 'input')[0].props.id).toBe(PATH_FIELD_ID);
  });

  it('shows the buffer value, carrying its leading slash', () => {
    expect(findAll(body('/orders'), (el) => el.type === 'input')[0].props.value).toBe('/orders');
  });

  it('raises the RAW typed text, unclamped and untruncated', () => {
    // Nothing is cut on the way in. A value the user cannot commit is refused with a
    // sentence that says why, never silently trimmed to something they did not type.
    const seen: string[] = [];
    const input = findAll(body('/a', (p) => seen.push(p)), (el) => el.type === 'input')[0];
    (input.props.onChange as (e: { currentTarget: { value: string } }) => void)({
      currentTarget: { value: '/a much longer thing' },
    });
    expect(seen).toEqual(['/a much longer thing']);
  });

  it('reads its maxLength from the mirrored constant, never a literal', () => {
    expect(findAll(body('/x'), (el) => el.type === 'input')[0].props.maxLength).toBe(
      MAX_ENDPOINT_PATH_BYTES,
    );
  });

  it('takes the full content width and tabular figures (72-UI-SPEC 3)', () => {
    // `tabular-nums` for the same reason the POST URL row has it: a path is read
    // character by character, and a proportional numeral makes `/v1/orders` and
    // `/v1/ordors` harder to tell apart at a glance.
    const style = findAll(body('/x'), (el) => el.type === 'input')[0].props.style as Record<
      string,
      unknown
    >;
    expect(style.width).toBe('100%');
    expect(style.fontVariantNumeric).toBe('tabular-nums');
  });

  it('sizes the Path by its border box, so it fits its column (CHROME-14, D-08)', () => {
    // `.fab-field` is content-box: `width: 100%` plus its padding and border ran the
    // box 18 px past the scroll column's content edge (91-MEASURE.md). Border-box keeps
    // the full width inside it, the `LabelConfigBody` precedent.
    const style = findAll(body('/x'), (el) => el.type === 'input')[0].props.style as Record<
      string,
      unknown
    >;
    expect(style.boxSizing).toBe('border-box');
    expect(style.width).toBe('100%');
  });

  it('spaces the wrapping hint at line height 1.4, the label above at 1 (CHROME-14)', () => {
    const tree = body('/x');
    const hint = findAll(tree, (el) => el.type === 'p')[0].props.style as Record<string, unknown>;
    const label = findAll(tree, (el) => el.type === 'label')[0].props.style as Record<string, unknown>;
    expect(hint.lineHeight).toBe(1.4);
    expect(label.lineHeight).toBe(1);
  });

  it('rides the shipped .fab-field inset well, minting no control of its own', () => {
    expect(findAll(body('/x'), (el) => el.type === 'input')[0].props.className).toBe('fab-field');
  });

  it('describes the field by the hint, and never marks the field invalid', () => {
    // The constraint is announced BEFORE a mistake, by `aria-describedby`. It is NOT
    // `aria-invalid`: the refusal is an inline `role="alert"` row with an icon as well
    // as destructive colour, which is the shipped rule that colour is never the only
    // cue, and marking the field would put a destructive border on a value at every
    // intermediate keystroke of a path the user is still typing.
    const input = findAll(body(''), (el) => el.type === 'input')[0];
    expect(input.props['aria-describedby']).toBe(
      findAll(body(''), (el) => el.type === 'p')[0].props.id,
    );
    expect(input.props['aria-invalid']).toBeUndefined();
  });

  it('teaches the exact-path rule BY EXAMPLE, naming no jargon', () => {
    // D-15 by example rather than by naming "wildcards" or "parameters", neither of
    // which is plain English to someone who has not met a router before.
    expect(PATH_HINT).toBe('An exact path. /users/42 and /users/43 are two Routes.');
    expect(PATH_HINT.toLowerCase()).not.toContain('wildcard');
    expect(PATH_HINT.toLowerCase()).not.toContain('parameter');
    expect(PATH_HINT.includes('—')).toBe(false);
  });

  it('mints no new spacing value: the label/field gap is the shipped sm token', () => {
    const root = findAll(body('/x'), (el) => el.type === 'div')[0];
    expect((root.props.style as Record<string, unknown>).gap).toBe('var(--fab-space-sm)');
  });
});
