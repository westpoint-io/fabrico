// RouteConfigBody.tsx - the Route's Path field and its client-side gate (SERVE-05).
//
// The card's FOCAL POINT (72-UI-SPEC 3): the one control this phase adds. It takes
// the first position after the heading and the full content width; nothing above it
// competes and nothing beside it shares its row. Everything else on the Route card
// either feeds it (the hint under it) or reports its consequence (the POST URL row
// below it).
//
// Split out of `ConfigPanel.tsx` as its own per-kind body, which is the shipped
// pattern every other configurable kind already follows (`FactoryConfigBody`,
// `SourceConfigBody`, `SinkConfigBody`, `BeltConfigBody`, `RouterConfigBody`). It is
// a HOOK-FREE pure function, so its whole unit suite invokes it directly in the
// repo's `node` vitest env with no DOM.
//
// Skin, not skeleton: the field is the shipped `.fab-field` inset well on the
// Martian Mono body tokens, and every colour is a `--fab-*` token. No new spacing
// value is minted - `var(--fab-space-sm)` between a label and its field is what
// every shipped config body already uses.

import type { CSSProperties, JSX } from 'react';
import type { MachineConfig } from '../protocol/decode.ts';

/**
 * The maximum Route path length in BYTES.
 *
 * # THE ONE TypeScript MIRROR, AND IT IS LOCKED
 * The authority is `fabrico_core::edit::MAX_ENDPOINT_PATH_BYTES`, read by the
 * `Configure` validate gate and by `snapshot::restore`'s trust gate. This is the
 * only copy of that number on this side of the language boundary, and
 * `crates/fabrico-command/tests/ts_bound_mirror.rs` `include_str!`s THIS FILE,
 * extracts the literal by the anchor below and asserts it equals the Rust constant.
 * The extractor PANICS if it cannot find the anchor, so a rename here is a red
 * rather than a green that measured nothing.
 *
 * That lock is the difference between this mirror and the one it copies.
 * `MAX_ROUTE_EXPECT_BYTES` in `RouterConfigBody.tsx` mirrors its Rust constant BY
 * HAND with nothing checking the two agree. That is the shipped precedent and it is
 * also a shipped gap; this one does not repeat it.
 *
 * # WHY A CONSTANT AND NOT A LITERAL AT THE TWO USE SITES
 * The bound is read TWICE here - once as the field's `maxLength` and once by the
 * over-length rule - and NEVER restated as a numeral in prose. The over-length
 * sentence states the OVERAGE, computed from this value. A restated figure is a
 * second source of truth, and `68-UI-SPEC` FINDING 1 is the worked example of what
 * that costs.
 */
export const MAX_ENDPOINT_PATH_BYTES = 1024;

/**
 * The bytes a Route path may contain beyond the structural rules, mirroring
 * `fabrico_core::edit::is_unreserved_path_byte`: ASCII letters, digits, and
 * `- . _ ~ /` (R-18's unreserved URL-path set, plus the separator).
 *
 * Spelled as a character class over ASCII, which is the same total rule the core
 * states one byte at a time. Percent sequences are NOT decoded and then judged: a
 * `%2e%2e` simply is not in the set, so it is refused. Refusing an alphabet is a
 * rule a reader can check; decoding first and judging after is where traversal
 * bugs live.
 */
const UNRESERVED_PATH = /^[A-Za-z0-9\-._~/]*$/;

/** One OTHER Route on the board: its committed path and the cell that names it. */
export interface RouteNeighbour {
  /** The render handle, so a caller can exclude the SELECTED Route by identity. */
  node: number;
  /** The Route's COMMITTED path - never a neighbour's in-progress buffer. */
  path: string;
  cell_x: number;
  cell_y: number;
}

/**
 * Why a typed path cannot be dispatched, or `null` when it can.
 *
 * A TAG plus its data rather than a pre-rendered sentence, so the copy lives in one
 * place ({@link routePathMessage}) and this predicate stays a statement about the
 * path. `over` is a count, `cell` is the shipped `(x,y)` label of the owning Route.
 */
export type RoutePathRefusal =
  | { tag: 'structure' }
  | { tag: 'charset' }
  | { tag: 'too-long'; over: number }
  | { tag: 'duplicate'; cell: string };

/** The `(x,y)` cell label a duplicate-path refusal names the other Route by (the Router's
 *  segments used the same format until phase 91 named them by number, UI-SPEC 8.6). */
function cellLabel(r: RouteNeighbour): string {
  return `(${r.cell_x},${r.cell_y})`;
}

/**
 * Why `path` cannot be dispatched against `others`, or `null` when it can.
 *
 * # THE FOUR RULES, AND WHY THEY ARE CHECKED IN THIS ORDER
 * Rules 1 to 3 mirror `fabrico_core::edit::endpoint_path_is_valid`; rule 4 is the
 * one that needs the whole board to answer and is the only one with its own typed
 * host refusal (`DuplicatePath`).
 *
 * 1. STRUCTURE first. A path starts with EXACTLY ONE `/` and is non-empty after it.
 *    This is the state a freshly cleared field is in, so it is the sentence a user
 *    meets most.
 *
 *    THE WORD *EXACTLY* IS CR-01, MIRRORED. `/` is in the unreserved set, so
 *    `//orders` used to pass rules 1 to 3, and rule 4 compares raw strings so it was
 *    not a duplicate of `/orders` either. The host keys every Route through
 *    `endpoint_route_key`, which trims ALL leading slashes, so both addresses keyed as
 *    `/orders` and the higher node id silently won: the shadowed Route's own card
 *    showed a POST URL that ran the OTHER Route's Handler. Only the LEADING slashes
 *    are trimmed, so interior ones are harmless and STAY LEGAL (walk item J-5 ruled
 *    that multi-segment paths like `/orders/new/id` must work). A rule spelled
 *    `path.includes('//')` would close the collision and break the ruling in one line.
 * 2. CHARSET second, and it is second ON PURPOSE. It is what makes the over-length
 *    sentence honest: the copy says "characters" while the bound is in BYTES, and
 *    the two units agree EXACTLY for the ASCII-only alphabet this rule enforces. A
 *    path that reaches rule 3 has therefore already been proved one byte per
 *    character, so the count the user reads is the count they must delete. Checking
 *    length first would let a CJK path report an overage in units it does not use.
 * 3. LENGTH third, stating the OVERAGE and never the bound.
 * 4. DUPLICATE last, because it is the only rule about the BOARD rather than about
 *    the string, and there is no point naming another Route's cell for a path that
 *    could never be committed anyway.
 *
 * # THIS IS A COURTESY. THE CORE IS THE AUTHORITY.
 * A frontend gate is untrusted input from the core's side. The wire is reachable
 * with no panel in the loop, so `fabrico-command`'s `Configure` arm refuses
 * independently and plan 72-07 proved it does. This exists so the panel STATES THE
 * CONSTRAINT rather than the host's causeless refusal stating it after the press,
 * which is `beltRunDispatchable`'s own recorded reason for existing.
 */
export function routePathRefusal(
  path: string,
  others: readonly RouteNeighbour[],
): RoutePathRefusal | null {
  if (!path.startsWith('/') || path.length < 2 || path.startsWith('//')) {
    return { tag: 'structure' };
  }
  if (!UNRESERVED_PATH.test(path)) return { tag: 'charset' };
  // Bytes, not UTF-16 code units. Identical here by construction (the charset rule
  // above admits ASCII only), and spelled as bytes anyway so it stays true of the
  // constant's own unit if that alphabet is ever widened.
  const bytes = new TextEncoder().encode(path).length;
  if (bytes > MAX_ENDPOINT_PATH_BYTES) {
    return { tag: 'too-long', over: bytes - MAX_ENDPOINT_PATH_BYTES };
  }
  const owner = others.find((r) => r.path === path);
  if (owner !== undefined) return { tag: 'duplicate', cell: cellLabel(owner) };
  return null;
}

/**
 * The sentence the user reads for a refusal. 72-UI-SPEC 8.2's three rows verbatim,
 * plus plan 72-01's R-18 fourth row - the ONE string this phase authors beyond the
 * approved UI-SPEC, and named in plan 72-14's judgement list for that reason.
 *
 * House voice: sentence case, terminal period, no apology, no "please", a plain
 * hyphen anywhere prose wants a dash, never U+2014 or U+2013.
 *
 * The over-length row states the OVERAGE. The BOUND is never typed as a numeral in
 * prose; it is derived from {@link MAX_ENDPOINT_PATH_BYTES} by the caller above.
 */
export function routePathMessage(refusal: RoutePathRefusal): string {
  switch (refusal.tag) {
    case 'structure':
      return 'A path starts with a single / and cannot be empty.';
    case 'charset':
      return 'That path has a character a URL cannot carry.';
    case 'too-long':
      return `That path is too long by ${refusal.over} character${refusal.over === 1 ? '' : 's'}.`;
    case 'duplicate':
      // NAMED HERE, and not by the host tag. `REFUSAL_COPY` is a Record over a
      // closed union with one authored string per key and no host string ever
      // interpolated, so `DuplicatePath` cannot name a Route. The panel can,
      // because it already polls the board. The tag carries the AUTHORITY, this
      // row carries the NAME, and that split is what D-13 asks for.
      return `That path is already used by the Route at ${refusal.cell}.`;
    default: {
      const _never: never = refusal;
      return _never;
    }
  }
}

/**
 * Can a `Configure` for this config be dispatched?
 *
 * DELIBERATELY THE SHAPE OF `beltRunDispatchable`: it takes the whole config and
 * answers `true` for every kind it says nothing about, so the Apply gate reads as
 * one conjunction of predicates over the same argument rather than as a chain of
 * kind tests. A caller cannot forget to guard the kind, because the predicate does.
 */
export function routePathDispatchable(
  config: MachineConfig | null,
  others: readonly RouteNeighbour[],
): boolean {
  if (config === null || config.kind !== 'Endpoint') return true;
  return routePathRefusal(config.path, others) === null;
}

/** The refusal sentence for a config, or `null`. `null` for every non-Route kind. */
export function routePathError(
  config: MachineConfig | null,
  others: readonly RouteNeighbour[],
): string | null {
  if (config === null || config.kind !== 'Endpoint') return null;
  const refusal = routePathRefusal(config.path, others);
  return refusal === null ? null : routePathMessage(refusal);
}

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The field's DOM id, exported so the panel's tests and the hint can bind to it. */
export const PATH_FIELD_ID = 'fab-route-path';
const PATH_HINT_ID = 'fab-route-path-hint';

/**
 * The Path hint. It teaches D-15 (literal paths only) BY EXAMPLE rather than by
 * naming "wildcards" or "parameters", neither of which is plain English to someone
 * who has not met a router before.
 */
export const PATH_HINT = 'An exact path. /users/42 and /users/43 are two Routes.';

export interface RouteConfigBodyProps {
  /** The in-progress path buffer, carrying its LEADING SLASH. */
  path: string;
  onChange: (path: string) => void;
}

/**
 * The Route card's Path block: label, field, hint. FULL CONTENT WIDTH, first
 * position after the heading (72-UI-SPEC 3).
 *
 * `tabular-nums` for the same reason the POST URL row has it: a path is read
 * character by character, and a proportional numeral makes `/v1/orders` and
 * `/v1/ordors` harder to tell apart at a glance.
 *
 * NOT `aria-invalid`, and never marked invalid on the field itself. The refusal is
 * an inline `role="alert"` row lower on the card carrying an icon as well as
 * destructive colour, which is the shipped `errorRow` and the shipped rule that
 * colour is never the only cue. The field is bound to the hint by
 * `aria-describedby` so the constraint is announced BEFORE a mistake, not after.
 */
export function RouteConfigBody({ path, onChange }: RouteConfigBodyProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label htmlFor={PATH_FIELD_ID} style={LABEL_STYLE}>
        Path
      </label>
      <input
        id={PATH_FIELD_ID}
        className="fab-field"
        type="text"
        // The keyboard-level bound, READ from the mirrored constant. It counts
        // UTF-16 code units, which is EXACT here rather than merely conservative:
        // the charset rule admits ASCII only, so any path that could ever be
        // committed is one byte per code unit. Nothing is clamped or truncated on
        // the way in - a value the user cannot commit is refused with a sentence
        // that says why, never silently cut.
        maxLength={MAX_ENDPOINT_PATH_BYTES}
        value={path}
        onChange={(e) => onChange(e.currentTarget.value)}
        aria-describedby={PATH_HINT_ID}
        // BORDER-BOX beside the full width (phase 91, CHROME-14, D-08; the
        // `LabelConfigBody` precedent). `.fab-field` is content-box, so `width: 100%`
        // plus its 0 8 px padding and 1 px border ran the box 18 px past the scroll
        // column's content edge and grew a horizontal scrollbar.
        style={{ width: '100%', boxSizing: 'border-box', fontVariantNumeric: 'tabular-nums' }}
      />
      {/* Line height 1.4 on the hint only (UI-SPEC section 4): it wraps, and at the
          label's 1 its lines touched. The `Path` label above stays 1. */}
      <p id={PATH_HINT_ID} style={{ margin: 0, ...LABEL_STYLE, lineHeight: 1.4 }}>
        {PATH_HINT}
      </p>
    </div>
  );
}
