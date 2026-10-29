// RouterConfigBody.tsx - the Router rules editor body (ROUTE-01/ROUTE-03).
//
// An ordered `Rules` list (each rule a `Match text` .fab-field, an `At byte`
// numeric .fab-field, and a `Send to` segmented control over the node's LIVE
// outputs) plus a `Default` segmented control whose first segment is
// `None (fault)`, over one read-only line stating where unmatched items go.
// Purely presentational: told the current table via props, raising the new
// table via onChange. The parent (ConfigPanel) holds the buffer and owns
// Apply / Revert, exactly as the Factory / Source / Sink arms do.
//
// TWO exports, and the split is load-bearing: `RouterConfigBody` is HOOK-FREE
// so its whole unit suite can invoke it directly, and `RouterConfigSection` is
// the thin wrapper ConfigPanel mounts, holding the one hook pair the body
// cannot (the after-a-move focus restore). See RouterConfigSection's docblock.
//
// Skin, not skeleton: every colour a `--fab-*` token, all text on the Martian
// Mono body tokens, 44px min-target on every control (the .fab-field /
// .fab-tool-btn classes carry it). No hand-authored hex, no new token, no
// native select element, no icon and no SVG.

import { useLayoutEffect, useRef, type CSSProperties, type JSX } from 'react';
import type { PortView, RouteKey } from '../protocol/decode.ts';
import type { PortFlow, PortReach } from '../protocol/portFlow.ts';
import { KIND_NAMES } from './kindNames.ts';
import { ROLE_OUT } from './PortsSection.tsx';

/** One routing rule on the wire: its key paired with its target ROUTING KEY. */
export type Route = [RouteKey, number];

// ─────────────────────────────── Copy contract ───────────────────────────────
// 65-UI-SPEC "Copywriting Contract". Sentence case with terminal periods,
// "cannot" as one word, no apology, no "please", no em dash and no en dash.
// Named constants so one vitest can pin them verbatim (the REFUSAL_COPY /
// PORT_REMOVE_COPY idiom) rather than a test re-typing the string it validates.

/** The rules section header. */
export const RULES_HEADER = 'Rules';
/** The default section header. */
export const DEFAULT_HEADER = 'Default';
/** The one standing paragraph under the Rules header.
 *
 *  Phase 91 (D-12, CHROME-13, UI-SPEC 8.6): the outputs are named by NUMBER, the
 *  number the Outputs list below shows on each row (`Output N - Item`), plus the
 *  machine each one's belt reaches. They used to be named by their nub's grid cell,
 *  `(15,0)`, the only grid coordinate the app ever showed a user, which said where
 *  a nub sat and nothing about where its items went. */
export const RULES_NOTE =
  'The first rule that matches wins. Output numbers match the Outputs list below.';
/** The empty-list row. The CONSEQUENCE is deliberately not restated here: the
 *  fallthrough line under the Default control already states it, and a second
 *  copy would go stale against the default. */
export const NO_RULES = 'No rules yet.';
/** The append control. Mirrors the shipped `+ Add output`. */
export const ADD_RULE_LABEL = '+ Add rule';
/** The per-rule move-up control's accessible name. The glyph is the visible
 *  text, so the label is the ONLY handle a reader has on which rule it moves. */
export const moveUpLabel = (n: number): string => `Move rule ${n} up`;
/** The per-rule move-down control's accessible name. */
export const moveDownLabel = (n: number): string => `Move rule ${n} down`;
/** The per-rule delete control's accessible name. Mirrors the shipped
 *  `Remove output ${ordinal + 1}` in `PortsSection`. */
export const deleteRuleLabel = (n: number): string => `Delete rule ${n}`;

/** The pattern field's label. */
export const EXPECT_LABEL = 'Match text';
/** The offset field's label. */
export const OFFSET_LABEL = 'At byte';
/** The per-rule target group's visible label. */
export const TARGET_LABEL = 'Send to';
/** The Default group's first segment: no default at all, which is legal. */
export const NO_DEFAULT_SEGMENT = 'None (fault)';
/** The fallthrough line when `default === null`.
 *
 *  # THE ARGUMENT ABOVE THIS LINE WAS INVERTED IN PHASE 71, NOT DELETED
 *
 *  It read: this string deliberately does NOT say "leave on the Fault port",
 *  because a Router declares no `Role::Fault` port at all - `port_catalog(ROUTER)`
 *  yielded one In plus the Outs, and `FAULT_PORT` was a RESERVED routing key with
 *  no `Port` record, therefore no nub, therefore no row in the Outputs list and
 *  nothing a belt could dock to. Naming it would have pointed the user at a port
 *  they would look for and not find, which is the
 *  recovery-clause-names-a-control-we-do-not-have mistake `PortsSection` records
 *  having been reverted once.
 *
 *  Every premise of that argument is now false. PILE-10 gives the Router a REAL
 *  spatial `Role::Fault` nub at `S@(0,2)` (`port_catalog(ROUTER)`, phase 71), so
 *  there IS a nub, there IS a row in the Outputs list, and a belt CAN dock to it.
 *  PILE-09 bounds the queue behind it and the fold drains it onto that belt. So
 *  the string says what happens, and the same discipline that kept it quiet before
 *  is what makes it speak now.
 *
 *  The argument is kept rather than replaced because a silently deleted argument is
 *  exactly the shape this milestone exists to stop: the next reader needs to see
 *  that the quiet version was right for its time and what changed under it. */
export const FALLTHROUGH_FAULT =
  'Items matching no rule leave on the fault port. Draw a belt from it to catch them.';
/** The fallthrough line when a default IS set, naming that output (UI-SPEC 8.6):
 *  `Output N (Target)` or `Output N`, from {@link outputName}. */
export const fallthroughTo = (output: string): string => `Items matching no rule go to ${output}.`;

/**
 * What a Router output is called (phase 91, D-12, CHROME-13, UI-SPEC 8.6): `Output N`,
 * N its routing key + 1, plus ` (Target)` when its belt reaches a machine.
 */
export const outputName = (n: number, target: string | null): string =>
  target === null ? `Output ${n}` : `Output ${n} (${target})`;

/**
 * The machine an output's belt reaches, as the panel names it: its `KIND_NAMES` name,
 * plus ` input K` when it has two or more In ports (K counted from 1 among its Ins).
 * `null` when the output's belt reaches no machine (none docked, or the chain ends on
 * open floor), which `selectedNodePortFlow` reports as an absent `reaches`.
 */
export function targetName(reach: PortReach | undefined): string | null {
  if (reach === undefined) return null;
  const kind = KIND_NAMES[reach.kind] ?? 'Machine';
  return reach.inputs >= 2 && reach.input >= 1 ? `${kind} input ${reach.input}` : kind;
}
/** The extra trailing segment for a routing key past the live Out list. It is
 *  what PRESERVES the single-select invariant in that state: without it the
 *  group renders with nothing pressed, which reads as "no target chosen" when
 *  in fact a target IS stored and simply no longer exists. */
export const MISSING_SEGMENT = 'Missing output';
/** Beneath a pattern whose bytes are not valid text. States the CONSEQUENCE of
 *  editing, because that is the one thing the user can do that changes them. */
export const NOT_TEXT = 'These bytes are not text. Editing this field replaces them.';
/** Beneath a group whose stored target is past the live Out list. A disclosure,
 *  not an error: nothing is blocked here. Apply still sends, the host refuses a
 *  table naming a dead port, and that verdict lands on the shared refusal
 *  element rather than being invented in this panel. */
export const TARGET_GONE = 'That output is gone. Choose another.';
/** Linked to the disabled append control on a Router with no Out ports. */
export const NO_OUTPUTS = 'This machine has no outputs to send to.';

/** The append control's reason element. Named so the control and its reason
 *  cannot drift apart. */
export const ROUTE_ADD_REASON_ID = 'fab-route-add-reason';
/** The always-present fallthrough line under the Default group. */
export const ROUTE_FALLTHROUGH_ID = 'fab-route-fallthrough';
/** A rule's not-text note. Positional, like every other id in a rule block. */
export const bytesNoteId = (i: number): string => `fab-route-bytes-note-${i}`;

// ────────────────────────────── Wire conversions ─────────────────────────────

/**
 * Coerce the `At byte` field's raw text to a committable `RouteKey.offset`: an
 * integer inside the u16 range (`crates/fabrico-core/src/state.rs`).
 *
 * The field is `type="text"` with a numeric keyboard and no range attributes
 * (phase 91, CHROME-14, D-08, A14), so a user can type `-5`, `1.9`, `70000`,
 * `abc`, or clear the field. Left unsanitized,
 * `PostcardWriter.varintU` mangles all of them: `-5` and `1.9` through the
 * int32 `& 0x7f` walk, and `70000` by encoding a value the Rust `u16` decode
 * cannot take. The LOGGED config would then silently diverge from what the
 * panel displays, through a certified, replayable `Configure`.
 *
 * `Number(raw) || 0` maps empty/NaN/0 to 0 (all falsy); `Math.floor` drops the
 * fraction; `Math.max(0, ...)` clamps negatives; `Math.min(65535, ...)` clamps
 * the u16 ceiling. The result is exactly the value that gets encoded, so
 * committed == displayed. This is the `sanitizeTimerInterval` shape
 * (`SourceConfigBody.tsx`) with this field's own bounds.
 */
export function sanitizeRouteOffset(raw: string): number {
  return Math.min(65535, Math.max(0, Math.floor(Number(raw) || 0)));
}

/**
 * Decode a rule's `expect` bytes for DISPLAY, reporting whether the decode was
 * lossy.
 *
 * `RouteKey.expect` is a `Vec<u8>` and nothing constrains it to UTF-8: the
 * shipped scenario fixture was authored with `b"A"`, and any byte string is
 * legal. Decoding `[0xff]` yields U+FFFD and re-encoding U+FFFD yields the
 * THREE bytes `ef bf bd`, so a lossy round trip would rewrite a pattern the
 * user never typed. That is why the buffer holds the wire bytes and this decode
 * is for display ONLY - see `RouterConfigBody`'s buffer contract.
 *
 * A `fatal: true` decoder throws on invalid UTF-8, which is the detection; the
 * fallback lossy decode is what still puts something legible in the field.
 * (U+FFFD is not in the 224-codepoint Martian Mono subset, so it renders as a
 * fallback-font box rather than a replacement mark - a second, independent
 * reason not to store the decode.)
 */
export function decodeExpect(bytes: number[]): { text: string; lossy: boolean } {
  const buf = Uint8Array.from(bytes);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), lossy: false };
  } catch {
    return { text: new TextDecoder().decode(buf), lossy: true };
  }
}

/**
 * The per-rule pattern cap, mirroring `MAX_ROUTE_EXPECT_BYTES` in
 * `crates/fabrico-core/src/edit.rs:130`. It is a BYTE count, not a character
 * count: `RouteKey.expect` is a `Vec<u8>` and the core bounds its length.
 *
 * WHY A CONSTANT AND NOT A LITERAL. The authoritative fence is the command
 * layer, which refuses a table carrying an over-cap pattern with a typed error
 * before any record is written (`command.rs`, the `Configure` arm). Everything
 * in this file is defence in depth plus a better place to be stopped: at the
 * keyboard rather than at Apply. A literal `1024` on the input and a second
 * literal in the clamp could drift apart from each other and from the core; one
 * named value cannot.
 */
export const MAX_ROUTE_EXPECT_BYTES = 1024;

/**
 * Encode typed field text back to the wire byte array, clamped to
 * [`MAX_ROUTE_EXPECT_BYTES`].
 *
 * # Bytes versus UTF-16 code units, and which one is enforced here
 * The field also carries `maxLength={MAX_ROUTE_EXPECT_BYTES}`, and that
 * attribute counts UTF-16 CODE UNITS. The two units agree exactly for ASCII,
 * which is what a match pattern almost always is, so for the overwhelming case
 * the user is stopped at the keystroke with no truncation at all. They do NOT
 * agree for anything else: 1024 code units of CJK is 3072 bytes, so
 * `maxLength` alone would let a table three times over the cap reach Apply.
 *
 * THE BYTE CLAMP IS THEREFORE THE REAL ONE HERE, chosen over "bound
 * conservatively and let the command layer refuse" for the same reason
 * [`sanitizeRouteOffset`] clamps its sibling u16 field rather than trusting the
 * advisory `max` attribute: what is committed must be what is displayed. The
 * field is controlled from `decodeExpect(key.expect)`, so a clamped encode
 * shows the user immediately where the field stopped accepting input, instead
 * of letting them type a pattern that looks stored and is refused wholesale on
 * Apply.
 *
 * The cut never splits a codepoint. `bytes[end]` is the FIRST byte that would
 * be dropped; while it is a UTF-8 continuation byte (`0b10xxxxxx`) the cut sits
 * inside a multi-byte sequence, so it walks back to the sequence start. Without
 * that walk, `decodeExpect` would meet a truncated sequence, mark the whole
 * pattern not-text, and put U+FFFD in a field the user typed real characters
 * into.
 */
export function encodeExpect(text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_ROUTE_EXPECT_BYTES) return Array.from(bytes);
  let end = MAX_ROUTE_EXPECT_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return Array.from(bytes.subarray(0, end));
}

// ────────────────────────────────── Styles ───────────────────────────────────
// Redeclared locally rather than exported from `PortsSection.tsx`: 65-UI-SPEC
// locks their VALUES, and widening that file's surface to share them would be a
// bigger diff than the copy.

/** A stacked field's label (the SinkConfigBody value, verbatim). */
const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The `<h3>` tier. `fontWeight: 'normal'` and the 1px hairline are both
 *  load-bearing: an `<h3>` is bold by UA default, and the rule below it (not a
 *  weight and not a size) is what separates a header from a row. */
const HEADER_STYLE: CSSProperties = {
  margin: 0,
  marginTop: 'var(--fab-space-sm)',
  paddingBottom: 'var(--fab-space-xs)',
  borderBottom: '1px solid var(--fab-outline)',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  fontWeight: 'normal',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The rules list: column flow at the row-to-row gap. */
const LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--fab-space-sm)',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

/** EVERY prose line in this arm: the shipped advisory GEOMETRY at FULL ink.
 *
 *  This is the `EDIT_STATUS_STYLE` shape (`PortsSection.tsx`). The advisory tier's
 *  old `--fab-outline` colour measured 1.636:1 on the panel fill, which is not a
 *  near miss at AA; `--fab-ink` measures 5.157:1, and since phase 91 (UI-SPEC A13)
 *  every advisory in the inspector wears it too. Only the emphasis differs: no new tier, no new size, no
 *  new token. `lineHeight: 1.3` is the value that keeps two-line prose from
 *  colliding ascenders into descenders. */
const NOTE_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.3,
};

/** A segmented group: wraps rather than overflowing the panel's content width.
 *  Measured: at the ledgered 992px minimum the panel content is 327px, and the
 *  Default row's `None (fault)` plus the cell segments exceeds that. This is
 *  the shipped `SinkConfigBody` Method-row treatment, for the same reason. */
const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--fab-space-xs)',
};

/** The append control keeps its own width instead of stretching the column. */
const ADD_BTN_STYLE: CSSProperties = { alignSelf: 'flex-start' };

/** The three per-rule controls: the shipped `REMOVE_BTN_STYLE` zeroing
 *  (`PortsSection.tsx`). `padding: 0` overrides the class's ring-inclusive
 *  padding but does NOT reduce the target - `.fab-tool-btn` carries
 *  `--fab-min-target` on BOTH `min-width` and `min-height`. It reaches no
 *  `--fab-bezel-ring` value either, so it does not enter the
 *  `dpr-crispness.spec.ts` padding-site derivation. */
const RULE_BTN_STYLE: CSSProperties = { padding: 0, flexShrink: 0 };
/** The first of the three, which also pushes the group away from the marker. */
const RULE_BTN_FIRST_STYLE: CSSProperties = { ...RULE_BTN_STYLE, marginLeft: 'auto' };

/** The two move controls' element ids. POSITIONAL on purpose: the focus restore
 *  addresses the button at the moved rule's NEW index, not the one that was
 *  pressed. */
export const moveUpId = (i: number): string => `fab-route-move-up-${i}`;
export const moveDownId = (i: number): string => `fab-route-move-down-${i}`;
/** The delete control's element id, positional for the same reason the move ids
 *  are: after a delete the surviving rules SHIFT, so the control focus must land
 *  on is named by the position it ends up at, not by the rule that was there. */
export const deleteRuleId = (i: number): string => `fab-route-delete-${i}`;

/** The append control's id. A constant rather than a literal because the delete
 *  focus chain names it as a candidate, and a control and the code that focuses
 *  it must not be able to drift apart. */
export const ROUTE_ADD_ID = 'fab-route-add';
/** The Default group's `None (fault)` segment. It is the LAST focus candidate
 *  after a delete because it is the one control in this arm that is never
 *  absent and never disabled: the rules list can empty, and `+ Add rule` is
 *  disabled on a zero-Out Router (state 8), but "no default" is always
 *  expressible and therefore always focusable. */
export const ROUTE_DEFAULT_NONE_ID = 'fab-route-default-none';

// ────────────────────────────── Render helpers ───────────────────────────────

/** The `Missing output` segment's handler. It is a READOUT of a stored value,
 *  not a choice: there is nothing to select back to. */
const noop = (): void => {};

/** One `.fab-tool-btn is-pressed` segment (the shipped pressed-toggle bevel). A
 *  render HELPER invoked directly (not `<Segment/>`) so the <button> inlines
 *  into the body tree for node-env test walking (the DeleteControl
 *  direct-invocation discipline; no hooks here).
 *
 *  A `<Segment/>` ELEMENT would appear in the returned tree as an opaque
 *  function type, so every walk for a real <button> would return nothing WHILE
 *  STAYING GREEN. Duplicated from `SinkConfigBody` rather than extracted to a
 *  shared module: that is the shipped idiom (`SourceConfigBody` declares its
 *  own too), and extracting would bump the chrome source-file census a second
 *  time and rewrite two shipped, tested files for no user-visible gain. */
function segment(
  label: string,
  pressed: boolean,
  onClick: () => void,
  id?: string,
  key: string = label,
): JSX.Element {
  return (
    <button
      // THE KEY IS THE SEGMENT'S IDENTITY, NOT ITS WORDS (phase 91 review WR-B-04). An output's
      // words carry the machine its belt reaches (UI-SPEC 8.6), which changes while the panel is
      // open, and a key that changed with them remounted the button and dropped a keyboard
      // user's focus to the page. Output segments pass `out-<routing key>`; the fixed segments
      // keep their fixed words.
      key={key}
      id={id}
      type="button"
      className={pressed ? 'fab-tool-btn is-pressed' : 'fab-tool-btn'}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** A stacked labelled `.fab-field` text row (render helper, invoked directly - same
 *  direct-invocation rule as `segment`). */
function field(
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
  opts?: { lossy?: boolean; describedBy?: string; maxLength?: number },
): JSX.Element {
  return (
    <div
      key={id}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
      // The not-text MARK. The visible disclosure note hangs off this in plan
      // 65-03; recording it here keeps the detection beside the decode that
      // found it rather than re-deriving it at the render site.
      data-fab-route-lossy={opts?.lossy === true ? 'true' : undefined}
    >
      <label htmlFor={id} style={LABEL_STYLE}>
        {label}
      </label>
      <input
        id={id}
        className="fab-field"
        type="text"
        // The keyboard-level bound. It counts UTF-16 code units, so it is EXACT
        // for ASCII and merely conservative for anything else; `encodeExpect`
        // holds the real byte cap. Passed rather than derived here so this
        // helper stays the shared shape both fields ride.
        maxLength={opts?.maxLength}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        // The not-text note is a DESCRIPTION and nothing else. The field is
        // deliberately never marked invalid: the shipped `.fab-field` invalid
        // styling means "the user's value is wrong", and these bytes are a valid
        // stored value that simply is not text. Marking them would tell a screen
        // reader the user made a mistake they did not make, and would put a
        // destructive border on a value they never typed. That absence is
        // machine-checked by a grep in the plan's acceptance criteria, which is
        // why the attribute name is not spelled out anywhere in this file.
        aria-describedby={opts?.describedBy}
      />
    </div>
  );
}

/** The rule's u16 `At byte` row (render helper, invoked directly, like `field`).
 *
 *  TEXT WITH A NUMERIC KEYBOARD, NO RANGE (phase 91, CHROME-14, D-08, A14; the
 *  belt pace field's precedent in `BeltConfigBody.tsx`). A number input draws the
 *  OS's light spin buttons, a white control on the dark panel on WebKitGTK, and
 *  its `min` / `max` enforced nothing: `sanitizeRouteOffset` on the change is the
 *  guard, so only an integer in 0..65535 reaches the Configure. Tabular figures.
 *  The field shows the rule's typed text while it has it (review WR-B-01, `offsetTyped`)
 *  and the sanitized figure once it is left, which `onBlur` asks for. */
function offsetField(
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
  onBlur: () => void,
): JSX.Element {
  return (
    <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label htmlFor={id} style={LABEL_STYLE}>
        {label}
      </label>
      <input
        id={id}
        className="fab-field"
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
        style={{ fontVariantNumeric: 'tabular-nums' }}
      />
    </div>
  );
}

// ─────────────────────────────── The component ───────────────────────────────

export interface RouterConfigBodyProps {
  /** The ordered match table. Order IS the behaviour: the first match wins. */
  routes: Route[];
  /** The default ("else") output ROUTING KEY, or null for "fault everything". */
  fallback: number | null;
  /** The selected node's LIVE render-packet ports, in PACKET order. */
  ports: PortView[];
  /** The selected node's live per-port flow (`selectedNodePortFlow`), keyed by
   *  `PortView.index`: each Out's `reaches` names the machine its belt reaches
   *  (UI-SPEC 8.6). Optional: without it every output is named by number alone. */
  flow?: ReadonlyMap<number, PortFlow>;
  /** Raise the whole new table. The parent holds the buffer. */
  onChange: (routes: Route[], fallback: number | null) => void;
  /** Told, immediately after a move raises its table, the element id of the
   *  move control the rule ARRIVES at, and the id of that rule's OTHER move
   *  control as a fallback. {@link RouterConfigSection} turns the pair into the
   *  focus restore; a direct caller (the node-env walk) may ignore it.
   *
   *  Two ids rather than one, because the arrival control is DISABLED at both
   *  ends of the list and a disabled button cannot hold focus. Walking a rule to
   *  the top with the up arrow is the commonest keyboard move there is, and on
   *  the last press the control under the finger goes dead: without a fallback,
   *  focus falls to the document body and the user is thrown out of the panel.
   *  The other control on the SAME rule is always live whenever there is more
   *  than one rule, so focus still lands on the rule that moved.
   *
   *  This seam exists at all because the body may hold NO hooks: it is invoked
   *  directly as a plain function by its whole unit suite, and `useRef` outside
   *  a React render throws. */
  onMoved?: (focusId: string, fallbackId: string) => void;
  /** Told, immediately after a delete raises its table, the ORDERED focus
   *  candidates for the control that should take focus now that the pressed one
   *  has unmounted. {@link RouterConfigSection} focuses the first that resolves
   *  to a live button; a direct caller (the node-env walk) may ignore it.
   *
   *  A LIST rather than a pair, because a delete has more ways to leave the
   *  panel than a move does. The pressed control is GONE, not merely disabled,
   *  so focus falls to `document.body` and the next Tab restarts at the top of
   *  the document: the user is thrown out of the panel mid-edit. That is the
   *  same defect {@link onMoved} exists for, reached by a different route, and
   *  it gets the same discipline: name where focus goes, then prove it lands
   *  there. */
  onDeleted?: (candidateIds: readonly string[]) => void;
  /**
   * The At byte fields' RAW typed text, keyed by rule index; a rule with no entry shows its
   * buffer's figure (phase 91 review WR-B-01, the belt pace field's `beltTyped` pattern). The
   * parent (`ConfigPanel`) holds it, because this body holds no hooks. Without it the field
   * showed the sanitized number after every keystroke, so `12.` snapped back to `12` and the
   * next `7` read `127`.
   */
  offsetTyped?: ReadonlyMap<number, string>;
  /** Told the whole next map: a rule's entry set on every keystroke, removed when its field is
   *  left, and the map emptied by a move or a delete, which renumber the rules. */
  onOffsetTyped?: (next: ReadonlyMap<number, string>) => void;
}

/** The empty typed-text map, shared so a default prop is one value. */
const NO_TYPED: ReadonlyMap<number, string> = new Map();

/**
 * The Router rules editor.
 *
 * # Output identity (the routing-key contract)
 * A rule's port number is the Out ROUTING KEY - the port's 0-based position
 * among `Role::Out` ports in PACKET order - and NOT its catalog index. That is
 * exactly what `dock_link_key` computes and what `Router::step` pushes to, and
 * `PortsSection` already derives the identical value and calls it the routing
 * ordinal.
 *
 * A Router's routing keys do NOT run top to bottom. Since plan 74.1-14 (the
 * ruling of 2026-10-04, "Edits keep middle layout") the catalog Router and a
 * palette Router seat their Outs alike, centre-out: key 0 on the MIDDLE row, key 1
 * below it, key 2 above it, and any added Out below those. No screen position
 * matches the keys, so until phase 91 the segments were labelled by their nub's
 * world cell. Since phase 91 (UI-SPEC 8.6) they are NUMBERED by the key itself,
 * `Output N` with N = key + 1, ordered by N, which is the order and the number the
 * Outputs list shows on its rows, and each carries the machine its belt reaches.
 * The value emitted is still the packet-order position.
 *
 * The list is read from the node, so a Router grown past the catalog by
 * `AddPort` needs no special case and no arity constant is restated here.
 *
 * # The buffer contract
 * `expect` is held as the wire byte array and NEVER as a string. The field
 * decodes for display only and re-encodes only from real typed text, so a rule
 * the user never touches rides through Apply byte-identically. See
 * {@link decodeExpect} for what a lossy round trip would otherwise do.
 */
export function RouterConfigBody({
  routes,
  fallback,
  ports,
  flow,
  onChange,
  onMoved,
  onDeleted,
  offsetTyped = NO_TYPED,
  onOffsetTyped,
}: RouterConfigBodyProps): JSX.Element {
  // PACKET order. `keyOf` is the value that goes on the wire, and since phase 91 the
  // display order too: segments are numbered and ordered by routing key (UI-SPEC 8.6).
  const outs = ports.filter((p) => p.role === ROLE_OUT);
  const keyOf = (p: PortView): number => outs.indexOf(p);
  const nameOf = (p: PortView): string => outputName(keyOf(p) + 1, targetName(flow?.get(p.index)?.reaches));
  const labelForKey = (key: number): string | null => {
    const port = outs[key];
    return port === undefined ? null : nameOf(port);
  };

  /** Replace rule `i` with `next`, leaving every OTHER rule's array entry
   *  untouched - which is what preserves the bytes of a pattern the user never
   *  typed in. */
  const replaceRule = (i: number, next: Route): void => {
    onChange(
      routes.map((r, j) => (j === i ? next : r)),
      fallback,
    );
  };

  const addRule = (): void => {
    // The first segment shown, which since phase 91 is Output 1.
    const first = outs[0];
    // A Router with zero live Outs has no target to offer. The AFFORDANCE is
    // the `disabled` attribute on the control below plus its linked reason, so
    // this path is unreachable from the panel; the early return is a totality
    // belt that keeps an empty list from being indexed, never the gate itself.
    if (first === undefined) return;
    onChange([...routes, [{ offset: 0, expect: [] }, keyOf(first)]], fallback);
  };

  /** Swap rule `i` with its neighbour `delta` away, and name the control the
   *  rule ARRIVES at.
   *
   *  Rules have no identity beyond position, so the React key is the position
   *  and the fields are controlled. That is right for the DATA (the whole rule
   *  travels: bytes, offset and target are one array entry) and WRONG for
   *  FOCUS - after the swap the DOM button that had focus belongs to the rule
   *  that moved the OTHER way, so a second press moves a different rule and a
   *  keyboard user holding the key gets a shuffle rather than a move. Naming
   *  the arrival control here is half the fix; {@link RouterConfigSection}
   *  focuses it. */
  const moveRule = (i: number, delta: number): void => {
    const j = i + delta;
    if (j < 0 || j >= routes.length) return;
    const next = [...routes];
    next[i] = routes[j];
    next[j] = routes[i];
    // Typed text is keyed by index, and a move renumbers two rules, so it is dropped.
    if (offsetTyped.size > 0) onOffsetTyped?.(NO_TYPED);
    onChange(next, fallback);
    onMoved?.(
      delta < 0 ? moveUpId(j) : moveDownId(j),
      delta < 0 ? moveDownId(j) : moveUpId(j),
    );
  };

  /** Drop rule `i`. Buffer-local and reversible by Revert, so it carries no
   *  confirmation and no destructive colour: a dialog on an action Revert
   *  already undoes trains a user to dismiss dialogs.
   *
   *  It also names where focus goes, in order of preference:
   *
   *    1. the delete control at the SAME index, which after the splice belongs
   *       to the rule that slid up into the freed slot. Deleting down a list
   *       then works like holding a key: the finger never moves.
   *    2. the delete control ABOVE, when the deleted rule was the last one and
   *       nothing slid into its slot.
   *    3. `+ Add rule`, when that was the only rule and the list is now empty.
   *    4. the Default group's `None (fault)` segment, when even the append
   *       control is disabled (state 8, a zero-Out Router that still carries a
   *       saved table).
   *
   *  Each candidate is checked for being a live button before focus is moved to
   *  it, so a disabled or absent one falls through rather than silently
   *  swallowing the focus - the `!el.disabled` lesson from the move restore. */
  const deleteRule = (i: number): void => {
    // As for a move: a delete renumbers every rule below it.
    if (offsetTyped.size > 0) onOffsetTyped?.(NO_TYPED);
    onChange(
      routes.filter((_, j) => j !== i),
      fallback,
    );
    const candidates: string[] = [];
    if (i < routes.length - 1) candidates.push(deleteRuleId(i));
    if (i > 0) candidates.push(deleteRuleId(i - 1));
    candidates.push(ROUTE_ADD_ID, ROUTE_DEFAULT_NONE_ID);
    onDeleted?.(candidates);
  };

  /** A stored routing key that no live Out answers to. Legal in a SAVED board
   *  (grow a Router, configure it, shrink it, reopen) and unreachable from the
   *  panel, which is exactly why it must render truthfully rather than throw or
   *  be silently rewritten to a live port. A silent rewrite in the buffer
   *  becomes a recorded user intent the moment Apply certifies it. */
  const targetGone = (key: number): boolean => labelForKey(key) === null;

  const defaultName = fallback === null ? null : labelForKey(fallback);
  const defaultGone = fallback !== null && defaultName === null;
  /** The always-present fallthrough line.
   *
   *  Three cases, and the third is the reason this is a function rather than a
   *  ternary: with the default's output gone, NEITHER the fault sentence nor
   *  the names-an-output sentence is true, so the line carries the disclosure the
   *  group already points at by description. That keeps one element, one
   *  `aria-describedby` target and one sentence a reader hears on entry. */
  const fallthroughLine = defaultGone
    ? TARGET_GONE
    : defaultName === null
      ? FALLTHROUGH_FAULT
      : fallthroughTo(defaultName);

  return (
    <div
      id="fab-router-config"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-md)' }}
    >
      <h3 id="fab-route-rules-header" style={HEADER_STYLE}>
        {RULES_HEADER}
      </h3>

      <p id="fab-route-note" style={NOTE_STYLE}>
        {RULES_NOTE}
      </p>

      <div role="list" aria-labelledby="fab-route-rules-header" style={LIST_STYLE}>
        {routes.length === 0 ? (
          <div role="listitem" style={NOTE_STYLE}>
            {NO_RULES}
          </div>
        ) : (
          routes.map(([key, port], i) => {
            const n = i + 1;
            const decoded = decodeExpect(key.expect);
            return (
              <div
                key={i}
                role="listitem"
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
              >
                {/* `flexWrap: 'wrap'` is the measured backstop: at the
                    ledgered 992px minimum the panel content is 327px, and the
                    three buttons drop to a second line rather than running past
                    the panel edge (the shipped ROW_MAIN_STYLE treatment). */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 'var(--fab-space-xs)',
                    ...LABEL_STYLE,
                  }}
                >
                  <span id={`fab-route-rule-label-${i}`}>{`Rule ${n}`}</span>
                  {/* A blocked move is the NATIVE `disabled` attribute and
                      carries NO reason element, deliberately: the
                      `PortsSection` docblock refuses one for a transient,
                      self-evident cause, and "it is already first" is
                      positional rather than a fact a reader needs told. 2N
                      positional reason nodes in a live panel is SR noise.

                      The glyphs are `↑` / `↓` / `×`, all three probed present
                      in the 224-codepoint Martian Mono subset. Triangles
                      (U+25B2 / U+25BC) are NOT in it and would render as
                      tofu. */}
                  <button
                    id={moveUpId(i)}
                    type="button"
                    className="fab-tool-btn"
                    style={RULE_BTN_FIRST_STYLE}
                    aria-label={moveUpLabel(n)}
                    disabled={i === 0}
                    onClick={() => moveRule(i, -1)}
                  >
                    ↑
                  </button>
                  <button
                    id={moveDownId(i)}
                    type="button"
                    className="fab-tool-btn"
                    style={RULE_BTN_STYLE}
                    aria-label={moveDownLabel(n)}
                    disabled={i === routes.length - 1}
                    onClick={() => moveRule(i, 1)}
                  >
                    ↓
                  </button>
                  <button
                    id={deleteRuleId(i)}
                    type="button"
                    className="fab-tool-btn"
                    style={RULE_BTN_STYLE}
                    aria-label={deleteRuleLabel(n)}
                    disabled={false}
                    onClick={() => deleteRule(i)}
                  >
                    ×
                  </button>
                </div>

                {field(
                  `fab-route-expect-${i}`,
                  EXPECT_LABEL,
                  decoded.text,
                  (text) => replaceRule(i, [{ offset: key.offset, expect: encodeExpect(text) }, port]),
                  {
                    lossy: decoded.lossy,
                    describedBy: decoded.lossy ? bytesNoteId(i) : undefined,
                    maxLength: MAX_ROUTE_EXPECT_BYTES,
                  },
                )}
                {decoded.lossy && (
                  <span id={bytesNoteId(i)} style={NOTE_STYLE}>
                    {NOT_TEXT}
                  </span>
                )}

                {offsetField(
                  `fab-route-offset-${i}`,
                  OFFSET_LABEL,
                  offsetTyped.get(i) ?? String(key.offset),
                  (raw) => {
                    onOffsetTyped?.(new Map(offsetTyped).set(i, raw));
                    replaceRule(i, [
                      { offset: sanitizeRouteOffset(raw), expect: key.expect },
                      port,
                    ]);
                  },
                  () => {
                    if (!offsetTyped.has(i)) return;
                    const next = new Map(offsetTyped);
                    next.delete(i);
                    onOffsetTyped?.(next);
                  },
                )}

                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
                >
                  <label style={LABEL_STYLE}>{TARGET_LABEL}</label>
                  {/* `aria-label`, never `aria-labelledby`: both the node-env
                      test resolver and the live Playwright resolver key on
                      `aria-label` ONLY, so a group named by reference is
                      invisible to both. It contains the visible `Send to`
                      verbatim (WCAG 2.5.3 label-in-name) while staying unique
                      per rule. */}
                  <div role="group" aria-label={`${TARGET_LABEL}, rule ${n}`} style={GROUP_STYLE}>
                    {outs.map((p) =>
                      segment(
                        nameOf(p),
                        port === keyOf(p),
                        () => replaceRule(i, [key, keyOf(p)]),
                        undefined,
                        `out-${keyOf(p)}`,
                      ),
                    )}
                    {/* No live segment matches a dead key, so without this one
                        the group would render with NOTHING pressed. It is a
                        readout of a stored value, not a choice, so pressing it
                        does nothing; pressing a real segment replaces the
                        target and it disappears. */}
                    {targetGone(port) && segment(MISSING_SEGMENT, true, noop)}
                  </div>
                </div>
                {targetGone(port) && <span style={NOTE_STYLE}>{TARGET_GONE}</span>}
              </div>
            );
          })
        )}
      </div>

      {/* The GATE on a zero-Out Router is this attribute, not a check inside
          `addRule`: a control that looks live and does nothing is the shape a
          user reads as a broken app. Its linked reason arrives with the rest of
          the zero-output disclosure. */}
      <button
        id={ROUTE_ADD_ID}
        type="button"
        className="fab-tool-btn"
        style={ADD_BTN_STYLE}
        disabled={outs.length === 0}
        aria-describedby={outs.length === 0 ? ROUTE_ADD_REASON_ID : undefined}
        onClick={addRule}
      >
        {ADD_RULE_LABEL}
      </button>
      {outs.length === 0 && (
        <span id={ROUTE_ADD_REASON_ID} style={NOTE_STYLE}>
          {NO_OUTPUTS}
        </span>
      )}

      <h3 id="fab-route-default-header" style={HEADER_STYLE}>
        {DEFAULT_HEADER}
      </h3>

      {/* `None (fault)` leads, matching the shipped convention that the
          default-state segment comes first (Debug in Sink, Webhook in Source).
          It is never absent, so "no default" is always expressible. */}
      <div
        role="group"
        aria-label={DEFAULT_HEADER}
        aria-describedby={ROUTE_FALLTHROUGH_ID}
        style={GROUP_STYLE}
      >
        {segment(
          NO_DEFAULT_SEGMENT,
          fallback === null,
          () => onChange(routes, null),
          ROUTE_DEFAULT_NONE_ID,
        )}
        {outs.map((p) =>
          segment(nameOf(p), fallback === keyOf(p), () => onChange(routes, keyOf(p)), undefined, `out-${keyOf(p)}`),
        )}
        {defaultGone && segment(MISSING_SEGMENT, true, noop)}
      </div>

      {/* A DESCRIPTION, never a live region: a reader hears the current
          consequence on entering the group and does NOT hear it re-read on
          every press, which `aria-pressed` already announces. */}
      <p id={ROUTE_FALLTHROUGH_ID} style={NOTE_STYLE}>
        {fallthroughLine}
      </p>
    </div>
  );
}

// ──────────────────────── The mounted wrapper (focus) ────────────────────────

/**
 * What `ConfigPanel` mounts. It is {@link RouterConfigBody} plus ONE behaviour
 * the body structurally cannot hold: after a move, focus follows the rule to its
 * new position.
 *
 * # Why this is a separate component rather than a hook in the body
 * `RouterConfigBody` is invoked DIRECTLY as a plain function by its whole unit
 * suite (the direct-invocation discipline that inlines the real `<button>` and
 * `<input>` nodes into the returned tree). React's `useRef` outside a render
 * throws `Cannot read properties of null (reading 'useRef')` - measured, not
 * assumed - so a hook in the body would take every one of those cases down. The
 * hooks live here instead, and this component invokes the body directly for the
 * same reason the body invokes `segment()` and `field()` directly: the tree
 * inlines rather than nesting an opaque function type.
 *
 * # Why a layout effect and not the click handler
 * The DOM has not re-rendered when the move handler runs, so the arrival button
 * does not exist yet. The effect runs after React commits and before paint, so
 * the focus lands with no intermediate frame. `getElementById` is the handle
 * because the per-rule buttons are inlined into the body's tree and carry no
 * individual React ref; their ids are POSITIONAL for exactly this purpose.
 */
export function RouterConfigSection(props: RouterConfigBodyProps): JSX.Element {
  const pendingFocus = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const ids = pendingFocus.current;
    if (ids === null) return;
    // Cleared BEFORE the focus call, so a throw cannot leave a stale id that
    // steals focus on some later, unrelated render.
    pendingFocus.current = null;
    for (const id of ids) {
      const el = document.getElementById(id);
      // A disabled button cannot hold focus, and the arrival control IS
      // disabled at both ends of the list. Falling through to the moved rule's
      // other control keeps focus on the rule that moved instead of dropping it
      // to the document body on the press that finishes the walk.
      if (el instanceof HTMLButtonElement && !el.disabled) {
        el.focus();
        return;
      }
    }
  });
  return RouterConfigBody({
    ...props,
    onMoved: (focusId, fallbackId) => {
      pendingFocus.current = [focusId, fallbackId];
    },
    // The SAME pending-focus slot the move restore uses, because it is the same
    // problem: a control that held focus is not there to hold it after the
    // commit. The loop above already walks a candidate list and skips anything
    // that is absent or disabled, so a delete needs no machinery of its own.
    onDeleted: (candidateIds) => {
      pendingFocus.current = candidateIds;
    },
  });
}
