// PortsSection.tsx (PANEL-02) - the config panel's read-only I/O list.
//
// Renders the SELECTED machine's ports, grouped Inputs / Outputs, one row per
// port reading `{Role} - {Medium}` (portLabels.ts). Fault ports (role 2) are
// outputs in the core model (`Role { In=0, Out=1, Fault=2 }`), so they nest
// under the SAME "Outputs" header - there is deliberately no Fault header
// (51-UI-SPEC assumption A6).
//
// Data source is the LIVE render packet's `NodeView.ports`, NOT `machine_config`
// (a ConfigView carries no ports at all, and the port-only kinds - Tee / Router /
// Balancer / Merge - have a NULL machine_config). That is why the caller mounts
// this OUTSIDE ConfigPanel's `config &&` guard, on `!loading` alone (the Endpoint
// front-door precedent, ConfigPanel.tsx:249-254).
//
// PORT ORDER (WR-05 - the earlier claim here was wrong and worth stating plainly):
// In ports precede Out ports in every SEEDED CATALOG entry, but that is a property
// of the seeds, NOT an invariant the core maintains. `reseat_ports` (state.rs:1010)
// does not reorder anything - it walks the list in place and rewrites only
// `local_offset` / `side` - and `fold_add_port` (tick.rs:392) plainly PUSHES. So
// after a single `+ Add output` a Factory's list is `[In, Out, Fault, Out]`: it is
// grouped by role only up to the first hand-added port.
//
// Everything below therefore partitions by `role` and NEVER by position. Do not
// reintroduce positional grouping (`slice`, "the tail is the fault group", an index
// range per role) - the very feature this file adds is what breaks it.
//
// Skin, not skeleton: EVERY colour is a `--fab-*` token (zero hand-authored hex),
// headers ride the BODY tier (Martian Mono base) so they never compete with the
// single `.fab-title` h2 (51-UI-SPEC A5), and spacing uses the declared
// `--fab-space-*` scale only.
//
// Accessibility (51-UI-SPEC "Accessibility"): a `<section aria-label="Ports">`
// holding one `role="list"` per group, each row a `role="listitem"`. The rows
// carry an EXPLICIT `aria-label` equal to their text because ARIA computes a
// listitem's name from the author, not from contents - without it the row would
// be nameless to a screen reader (and to a by-name query). Rows are not
// focusable; only the Phase-51 add/remove controls (Plan 03) will be.

import type { CSSProperties, JSX } from 'react';
import type { PortView } from '../protocol/decode.ts';
import type { PortFlow, PortLink } from '../protocol/portFlow.ts';
import { machine_kind } from '../protocol/kinds.ts';
import { PORT_STATUS, type PortStatus } from './configCopy.ts';
import { PortIndicator } from './PortIndicator.tsx';
import { LABEL_SEPARATOR, mediumLabel, portRowLabel, roleLabel } from './portLabels.ts';

/** Core role bytes (state.rs:703). Fault is an OUTPUT role, hence the nesting. */
const ROLE_IN = 0;
/** Exported: ConfigPanel encodes `AddPort { role: Out }` from the same constant,
 *  so the panel and this section can never disagree on the role byte. */
export const ROLE_OUT = 1;
const ROLE_FAULT = 2;

const INPUTS_HEADER_ID = 'fab-ports-inputs';
const OUTPUTS_HEADER_ID = 'fab-ports-outputs';

/** Group headers: body tier (`--fab-font` base), full ink, `--fab-space-sm` lead,
 *  and the hairline rule that makes them headers.
 *
 *  51-UI-REVIEW: without that rule, `Inputs` and `Outputs` were
 *  character-for-character identical to the rows beneath them - same family,
 *  size, weight AND colour, differing only by an 8px top margin. The UI-SPEC
 *  anticipated the risk and answered it with "differentiate by full colour +
 *  top margin" (A5), but rows sit at full ink too, so half of that differentiator
 *  never existed and the section rendered as one uniform column of 12px grey text
 *  in which two lines happen to be group names.
 *
 *  The hairline is the answer the UI-SPEC's own colour table already promised
 *  (`--fab-outline` - "Hairline separators") and which was simply never built:
 *  there was not one border in this file. It is the right differentiator here
 *  because it costs no typographic tier (A5 keeps the single `.fab-title` h2, and
 *  the copy contract is untouched - a rule is not a word), and it draws the group
 *  BOUNDARY at the same time, which is the thing a uniform 8px gap could not. */
const HEADER_STYLE: CSSProperties = {
  margin: 0,
  marginTop: 'var(--fab-space-sm)',
  paddingBottom: 'var(--fab-space-xs)',
  borderBottom: '1px solid var(--fab-outline)',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  // An <h3> is bold by UA default; the body tier is NOT a weight change (the
  // header rides the body tier by 51-UI-SPEC A5 - the rule below it is what
  // separates it from a row, not a weight or a size).
  fontWeight: 'normal',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** A group's row list: column flow at the row-to-row gap. */
const LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--fab-space-sm)',
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

/** One port row. A COLUMN of at most two lines (51-UI-REVIEW fix 2):
 *
 *    line 1  [silhouette] [label] [status] ......... [remove?]
 *    line 2  the block reason / standing note, when there is one
 *
 *  It used to be ONE flex line holding all four elements plus the reason, and
 *  that row did not fit. The panel has a vertical scroll story only - no
 *  horizontal one. A `later-dock` row is `[12 glyph][Output - Item][not
 *  connected][44px button][Disconnect the belt or wire on a later output
 *  first]`, and at the MEASURED Martian Mono advance that reason ALONE demands
 *  408px, wrapping to 2 lines with 0px of clipping (browser-measured at a 992px
 *  viewport by plan 67-06, in `e2e/panel-disconnect.spec.ts`; the row's own
 *  content box there is 327px). The last-output note this slot shipped until
 *  phase 91 (94 characters) demanded 752px over 3 lines in the same box and the
 *  same run; its replacement, the docked-output note, is 42 characters and one
 *  line at the checked sizes (UI-SPEC 8.4). With no `flexWrap` and text spans at the default
 *  `min-width: auto` the single line could neither wrap nor shrink. It simply ran
 *  past the panel edge.
 *
 *  HOW WIDE IS THE CONTENT BOX? Two shipped comments disagree and one of them is
 *  STALE; 67-BASELINE.md's `## Row width` records the disagreement and does not
 *  resolve it, and neither does this comment.
 *    - THIS file said the box is at most ~388px: `width: min(420px, 33vw)` less
 *      `md` padding, citing `ConfigPanel.tsx:251` - a line reference that has
 *      since drifted onto an unrelated `ports` docblock.
 *    - `ConfigPanel.tsx` (the `aside` docblocks at :367 and :417-419) says an
 *      `aside` is CONTENT-BOX, so `min(420px, 33vw)` IS the content width and
 *      the padding sits outside it.
 *  Either the padding comes off the 420px or it does not; they cannot both hold.
 *  DO NOT resolve it by picking one here. THE GUARD ABOVE IS IMMUNE TO WHICH IS
 *  RIGHT: `e2e/panel-disconnect.spec.ts` compares this note against the widest
 *  note the slot already ships, both measured in the SAME run in the SAME box,
 *  so a wrong absolute box figure moves both readings identically and cannot
 *  turn a real regression green. That is the reason to measure relatively rather
 *  than to assert a pixel bound (WINDOWS id 4).
 *
 *  That is not an edge case. On a wired-up Factory *blocked* is the ordinary
 *  state of most Out rows, and `later-dock` - the longest of the three reasons -
 *  is the one that fires on every Out sitting above a docked one. Dropping the
 *  reason to its own line is what makes the common case fit.
 *
 *  `lineHeight: 1` is kept for the control line (single-line text) and
 *  deliberately NOT inherited by the note, which wraps - see ROW_NOTE_STYLE. */
const ROW_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--fab-space-xs)',
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The row's CONTROL line. `gap`, never fixed widths, so a longer medium word
 *  reflows; `flexWrap` is the backstop for the UI-SPEC's unresolved `long-text`
 *  case (a future medium word wider than the panel drops the control to a second
 *  line instead of overflowing it).
 *
 *  Phase 91 (UI-SPEC 8.5): the gap is `--fab-space-sm`, so the label and the
 *  status word never read run together (`Output - Item idle`). */
const ROW_MAIN_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--fab-space-sm)',
};

/** The empty-group row: same geometry, at full ink (phase 91, UI-SPEC Color:
 *  `--fab-outline` is 1.64 : 1 on the panel and fails AA, so no word wears it). */
const NONE_ROW_STYLE: CSSProperties = { ...ROW_STYLE, color: 'var(--fab-ink)' };

/** The empty-group copy - one dim `None` row under a header with zero ports. */
export const EMPTY_GROUP_LABEL = 'None';

/**
 * The tint + status word for one port's flow entry (PANEL-04; phase 91, D-12,
 * CHROME-13, UI-SPEC 8.5). The word is one of the four `PORT_STATUS` words
 * (`configCopy.ts`, so the specs import what this renders), and it - not the tint -
 * is the load-bearing flow cue, which is why `not connected` and `idle` are
 * DIFFERENT words rather than two shades of the same dim.
 *
 * NO COUNT. The row used to read `{n} moving`, so a belt jammed solid read `12
 * moving` while nothing on it could move (todo 2026-10-20). The state comes from
 * `selectedNodePortFlow`, which reads the packet's facts: `backedUp` when a docked
 * belt's head slot holds an item that cannot leave, `carrying` when one carries
 * items at all. `backed up` wins over `moving`, so a fan-in port with one jammed
 * belt says so.
 *
 * A MISSING entry is the same as an undocked one: the flow map is poll-derived,
 * so a row can paint one frame ahead of its snapshot (and Plan 03 will mount
 * rows the map has not seen yet). "Not connected" is the honest read in both
 * cases - never a crash, never a blank cell (T-51-03 / the UI-SPEC `partial`
 * backstop).
 *
 * Role plays NO part here on purpose: a Fault port walks the SAME neutral
 * dim -> ink -> item-accent steps as any other exit, so an idle fault port can
 * never read as a live alarm (`--fab-destructive` belongs to the error row
 * alone - RENDER-04 / machines.ts:74-77).
 */
export function portFlowVisual(entry: PortFlow | undefined): {
  status: PortStatus;
  /** The indicator tint (a `--fab-*` token reference, never a hex). */
  tint: string;
  /** The status word's own colour: always full ink (UI-SPEC 8.5, 5.16 : 1). The dim
   *  cue that nothing is attached stays on the glyph, which is non-text. */
  statusColor: string;
} {
  if (!entry || !entry.docked) {
    return {
      status: PORT_STATUS.notConnected,
      tint: 'var(--fab-outline)',
      statusColor: 'var(--fab-ink)',
    };
  }
  if (entry.backedUp) {
    return { status: PORT_STATUS.backedUp, tint: 'var(--fab-accent-item)', statusColor: 'var(--fab-ink)' };
  }
  if (entry.carrying) {
    return { status: PORT_STATUS.moving, tint: 'var(--fab-accent-item)', statusColor: 'var(--fab-ink)' };
  }
  return { status: PORT_STATUS.idle, tint: 'var(--fab-ink)', statusColor: 'var(--fab-ink)' };
}

/** The indicator wrapper: it - NOT the row - carries the flow tint, so the
 *  glyph's `currentColor` picks it up while the label text stays full ink (the
 *  51-UI-SPEC colour table keeps the status word readable rather than accent-washed). */
const INDICATOR_STYLE: CSSProperties = { display: 'inline-flex', alignItems: 'center' };

/** The per-Out remove control: a SQUARE `.fab-tool-btn` at the 44px min target
 *  (the padding reset is what makes it square rather than pill-shaped; the bezel
 *  geometry is constant enabled/disabled by the shared CSS, App.tsx:2112-2124).
 *
 *  `marginLeft: 'auto'` is the fix for 51-UI-REVIEW's first finding, and it is
 *  the whole fix. The button is the control line's LAST child, so without it the
 *  button's x is `indicator + label + status` - and the status is the one span in
 *  the row whose width MOVES. It re-derives from the ~10Hz flow poll and swaps
 *  between `idle` (4 chars), `moving` (6), `backed up` (9) and `not connected`
 *  (13): a ~70px slide between states (until phase 91 the count word also
 *  twitched a character whenever a belt crossed a power of ten). A destructive control that walks
 *  around under the pointer is the single most likely thing in this section to
 *  read as broken.
 *
 *  The auto margin eats the line's free space instead, pinning the button to the
 *  row's RIGHT edge - a fixed column, because the row is stretched to the panel's
 *  content width. Nothing upstream needs a fixed width for this to hold: the
 *  label starts at a fixed x and the status starts after a fixed-width label, so
 *  with the button pinned right, every element in the row now has a stable left
 *  edge. (`tabular-nums` would be redundant on top - Martian Mono is monospaced,
 *  and the auto margin already absorbs every width the word takes.) */
const REMOVE_BTN_STYLE: CSSProperties = { padding: 0, flexShrink: 0, marginLeft: 'auto' };

/** The SAME square control, TRAILING inside a `[Disconnect, Remove]` cluster.
 *
 *  Identical to {@link REMOVE_BTN_STYLE} but for the auto margin, and the
 *  difference is the whole of UI-SPEC 2.3's rule: the FIRST control in a row's
 *  cluster eats the line's free space, every later one takes none. Two `auto`
 *  margins would SPLIT the free space between them and push the pair apart, which
 *  is the opposite of the anchoring the auto margin buys in the first place.
 *
 *  A row with Remove alone still uses {@link REMOVE_BTN_STYLE} - Remove is then
 *  first in its own cluster - so every pre-CONNECT-01 row is unchanged. */
const REMOVE_BTN_TRAILING_STYLE: CSSProperties = { padding: 0, flexShrink: 0 };

/** CONNECT-01's control: a TEXT `.fab-tool-btn`, so no `padding: 0` reset (that
 *  reset is what makes Remove square; a text label needs its normal padding).
 *
 *  It is always FIRST in the `[Disconnect?, Remove?]` cluster - the more broadly
 *  applicable verb, offered on every role - so it always carries the auto margin
 *  and Remove trails it by one `--fab-space-sm` row gap. */
const DISCONNECT_BTN_STYLE: CSSProperties = { flexShrink: 0, marginLeft: 'auto' };

/** The row's second line: the docked-output note (phase 91, UI-SPEC 8.4).
 *
 *  Full ink body text (51-UI-SPEC colour table) - the note is TEXT, so it
 *  survives colour-blindness, greyscale and a skin swap.
 *
 *  NO INDENT, since phase 91, and the reason is measured. Until then `paddingLeft`
 *  aligned the note under the row's LABEL column (the glyph box plus the row gap).
 *  UI-SPEC 8.4 holds the docked-output note to ONE line at every checked window size:
 *  42 characters, 336 px of Martian Mono, in the column the panel has at 1024 wide,
 *  measured at 338 px. Under the 20 px indent the run was 318 px and the note wrapped
 *  (`e2e/panel-disconnect.spec.ts`, the note line case at 1024x768). The plan pins the
 *  note's words, so the indent goes and the note takes the whole column, starting at
 *  the row's own left edge under the glyph.
 *
 *  `lineHeight: 1.3` stays: a narrower window than the checked sizes still wraps it,
 *  and the row's own `lineHeight: 1` is cramped the moment prose runs to two lines. */
const ROW_NOTE_STYLE: CSSProperties = {
  color: 'var(--fab-ink)',
  lineHeight: 1.3,
};

/** The Add control sits after the Outputs rows (below the add note when there is
 *  one); `flex-start` keeps it its own width instead of stretching across the
 *  section's column flow. */
const ADD_BTN_STYLE: CSSProperties = { alignSelf: 'flex-start' };

/** The Add control's copy (51-UI-SPEC "Copywriting Contract"). */
export const ADD_OUTPUT_LABEL = '+ Add output';

/** CONNECT-01's copy (67-UI-SPEC section 1) - the ONE new user-facing word this
 *  phase coins. `Disconnect`, not `Unlink`: the protocol doc's own note
 *  (`fabrico-protocol/src/lib.rs:760-768`) says `Unlink` was chosen to match an
 *  existing core function name, NOT because it is the right user word. It also
 *  reads correctly for both mediums without qualification - it says nothing about
 *  belt or wire - which the pre-67-06 dock-block reasons, each of which named the
 *  belt medium outright, did not. Those reasons were made medium-agnostic for the
 *  same reason this label is, and 73-08 then deleted them outright along with the
 *  frontend dock-safety gate that produced them: the core survives the removal now
 *  (`fold_remove_port`, plan 73-06), so the panel has nothing to refuse. */
export const DISCONNECT_LABEL = 'Disconnect';

/** Plan 74.1-19 (review WR-02, re-walk J10): the note beside `+ Add output`, shown
 *  exactly when the host would REFUSE one more output because a belt is in the way.
 *
 *  WHAT IT PROMISES. That pressing `+ Add output` now would be refused with
 *  `GrowCoversBelt` ("Growing would cover a belt. Move that belt first."): the Factory
 *  is full, one more output needs another row (or column, on a turned Factory, but
 *  always the box's own next row), and the first occupied cell of that row in the
 *  host's walk is a belt tile. Nothing else. On the demo Factory that belt is its fault
 *  belt, which leaves the bottom of the machine.
 *
 *  WHAT IT IS HELD TO. The condition is `addOutputVerdict` (`protocol/addOutput.ts`)
 *  answering `blocked-by-belt`, which `addOutput.test.ts` asserts against every row of
 *  `add_output.expected.json`: 208 REAL `GridSession` AddPort verdicts over rotations
 *  0..3, five boards and every dock set. The sentence it replaces ("Adding an output
 *  makes this machine bigger and disconnects its fault belt.") was a hand rule; scored
 *  against the same table it promised a release the host never performs on all 16 rows
 *  it was shown for, and stayed silent on 16 belt refusals.
 *
 *  WHY THE BUTTON STAYS ENABLED. Phase 64 D-07: the host is the judge. The client
 *  predicts, it never gates; pressing the button anyway shows the host's own refusal
 *  sentence, which says the same thing in growth words.
 *
 *  75 characters (measured with `python3 len`), no dash. */
export const ADD_BLOCKED_BY_BELT_NOTE =
  'One more output needs another row, and a belt is in the way. Move it first.';

/** Plan 74.1-19 (re-walk J10): bring the add note AND the `+ Add output` button
 *  below it into the panel's visible scroll area the moment the note first appears.
 *
 *  WHY A SCROLL, MEASURED. At a 1280x720 window a full Factory's panel is 799px of
 *  content in a 628px scroll area (the code editor alone is 290px), and the Ports
 *  section's tail is where the note lives. Placing the note directly above the button
 *  was tried first and measured: the note still spanned y 702..733 against a visible
 *  46..674. So the panel scrolls, by the least amount that shows both (the
 *  `block: nearest` rule), and only its own scroll container
 *  (`[data-fab-panel-scroll]`), never the page.
 *
 *  WHEN. A React ref callback with a STABLE identity (this module-level function) is
 *  called once when the note's element mounts and once with `null` when it unmounts,
 *  so the scroll happens when the note first appears (on selecting a Factory that
 *  already shows it, or when an add makes it appear) and never on the ~10 Hz
 *  re-renders in between: a user who scrolls away is not pulled back. */
function revealAddNote(note: HTMLElement | null): void {
  if (note === null) return;
  const scroller = note.closest<HTMLElement>('[data-fab-panel-scroll]');
  if (scroller === null) return;
  const button = note.nextElementSibling ?? note;
  const view = scroller.getBoundingClientRect();
  const top = view.top + scroller.clientTop;
  const bottom = top + scroller.clientHeight;
  const want = { top: note.getBoundingClientRect().top, bottom: button.getBoundingClientRect().bottom };
  if (want.bottom > bottom) {
    // Down by the overflow, but never so far that the note's own top leaves the view.
    scroller.scrollTop += Math.min(want.bottom - bottom, Math.max(0, want.top - top));
  } else if (want.top < top) {
    scroller.scrollTop -= top - want.top;
  }
}

/** The id linking {@link ADD_BLOCKED_BY_BELT_NOTE} to the Add button. */
const ADD_ADVISORY_ID = 'fab-port-add-advisory';

/** Phase 91 (D-12, CHROME-13, UI-SPEC 8.4): A NON-FACTORY OUTPUTS GROUP ENDS AT ITS LAST ROW.
 *
 *  QA-02 wall 3 gave every non-Factory Outputs group a standing sentence saying
 *  adding and removing outputs is a Factory capability. It stood under every Source,
 *  Sink, Router, Tee, Merge, Balancer, Route and Belt the builder selected, and it
 *  explained the absence of a control nothing on those machines suggests exists:
 *  a note that applied nowhere it was shown. The missing control explains itself, so
 *  the sentence is deleted, not reworded. */

/** WR-08: what a FACTORY says when it has no way to add an output.
 *
 *  `editable` is not the only thing that can remove `+ Add output` from the DOM:
 *  the Add block is gated on `editable && onAddOutput`, so a FACTORY rendered
 *  without a handler met no control, no note and no reason. On a Factory the
 *  control is expected, so its absence needs this sentence; on every other kind
 *  it is not, and since phase 91 those groups say nothing (above).
 *
 *  It is a SECOND string rather than a reuse because the sibling's wording would
 *  be actively wrong here: telling a user standing in a Factory's panel that
 *  "only a Factory can add outputs" explains nothing and reads as a
 *  contradiction. This one says only what the panel can actually observe - that
 *  it has no way to add an output right now - and, per the house rule stated
 *  above for PORT_EDIT_STALLED, fabricates no cause for it (the panel cannot see
 *  why the handler is absent, and guessing would be the defect, not the fix).
 *
 *  Shortened alongside its sibling in 52-07, and for the same measured reason.
 *  This one was not named by the gap, but it occupies the SAME slot with the same
 *  style and the same two-line budget, and its previous wording was seven
 *  characters longer than the one already proved to break that budget - so it had
 *  the defect by arithmetic. It carries no e2e line measurement of its own because
 *  the state that renders it is unreachable from the app (`ConfigPanel` always
 *  passes an add handler); `PortsSection.test.tsx` holds its budget instead.
 *
 *  SHORTENED AGAIN (52 WR-06), because the 52-07 cut was sized against a WRONG
 *  number. The node-side budget ran at an ESTIMATED 29 columns ("211px of run ...
 *  ~7.2px advance"); the browser measurement that gate now performs says Martian
 *  Mono's real advance at `--fab-font-size-base` is 8.0px, so the slot is 26
 *  columns at the 640px viewport, not 29. 'Adding and removing outputs is
 *  unavailable here.' wraps to THREE lines at 26 - it was over budget the whole
 *  time, and the old calibration could not see it because the sibling it
 *  calibrated against wraps to 2 lines anywhere from 21 to ~40 columns.
 *
 *  The wording keeps the sibling's own "add or remove outputs" vocabulary, still
 *  states only what the panel can observe, and still fabricates no cause. This
 *  applies the standing 52-07 decision - shorten the copy rather than relax
 *  the budget - to the corrected measurement. */
export const OUTPUT_EDIT_UNAVAILABLE_NOTE = 'Outputs cannot be added or removed here.';

/** The id linking the Factory's fixed-outputs note to the Outputs group (phase 91:
 *  the only note left in that slot). */
const NON_FACTORY_NOTE_ID = 'fab-port-fixed-outputs-note';

/** CR-01: what the panel says while a port edit is UNACKNOWLEDGED.
 *
 *  This is a STATUS, not an alert, and it states only what the panel can
 *  observe: the edit was sent and the topology has not changed yet. It is
 *  deliberately not a verdict - and since Phase 64 that is a DECISION rather than
 *  a limit. The gesture channel does now answer: a refused port edit comes back on
 *  the reply seam (`SimLoop::acquire_input` in `crates/fabrico-host/src/sim_loop.rs`)
 *  and names its reason in the shared `#fab-refusal` surface, because this edit
 *  rides App's `submitInput` like every other gesture.
 *
 *  READ THE SCOPE EXACTLY. This sentence is driven by the LATCH, which watches the
 *  echo and nothing else, so it covers a refused edit too: a refusal produces no
 *  fold, so a refused edit reads "waiting" here exactly as an un-ticked one does,
 *  with its reason already said on the other surface. What the panel must never do
 *  is guess WHICH - the previous shape inferred a rejection from a 1 s timer and
 *  was wrong every time the sim was merely paused, and a verdict existing on
 *  another surface is no licence to re-derive one from silence here. Whether this
 *  panel should CONSUME the verdict (release the latch, label its own copy) is
 *  WINDOWS row 72, deliberately not decided mid-execution.
 *
 *  The paused variant is the one that earns its keep: `SimLoop::step` skips
 *  `acquire_input()` in `RunState::Frozen` and HOLDS input in
 *  `RunState::Draining`, so an edit made while paused is buffered until Resume.
 *  Telling the builder that turns a control that "does nothing" into a control
 *  that is waiting for them. */
export const PORT_EDIT_PENDING = 'Waiting for the host to apply this change.';
export const PORT_EDIT_PENDING_PAUSED =
  'The sim is paused - this change applies when you resume.';

/** WR-01: what the panel says once the edit has gone unfolded for
 *  `PORT_EDIT_STALL_TICKS` of SIMULATED time.
 *
 *  Read it carefully against what it deliberately does NOT say. It does not say
 *  the host rejected the edit, or that there was no room, or that anything
 *  failed. Since Phase 64 a rejection IS knowable - the host answers one on the
 *  reply seam and it is shown in `#fab-refusal` - but it is not knowable FROM
 *  HERE: this status is driven by the latch, the latch watches the echo, and a
 *  refused edit and a merely un-ticked one look identical to an echo watcher.
 *  Both reach this sentence, so all three claims above would still be
 *  fabrications for one of the two. The fabricated one ("no room to grow the
 *  machine here", the reverted `PORT_EDIT_REJECTED` table) is what got iteration
 *  1's fix reverted, and it STAYS reverted: a real verdict on another surface is
 *  not permission to restore a guessed one here. It states the one thing the
 *  panel can actually observe: the sim has moved on and this has not landed.
 *
 *  What earns its keep is the BUTTON beside it. Without a recovery path a
 *  never-folding edit disables the whole Outputs group for as long as the machine
 *  stays selected - and now that the latch survives a remount (CR-01), there is
 *  no deselect/reselect escape left either. `AddPort` really does return
 *  `OutOfBounds` / `GrowBlocked` (`FootprintCollision` until plan 88-02) on a packed board or at a grid edge
 *  (`validate_normalize`'s `AddPort` arm), which a Factory reaches on its 4th
 *  Out, so this is a state real builders reach - not a theoretical one. Note that
 *  those two now arrive as SENTENCES in `#fab-refusal` (Phase 64); this stalled
 *  status is what remains for the edit that gets no answer at all. */
export const PORT_EDIT_STALLED = 'The host has not applied this yet.';

/** The escape's label. It clears the latch and nothing else: the next click is an
 *  ordinary edit against the topology on screen, not a re-send of the old one. */
export const PORT_EDIT_RETRY_LABEL = 'Try again';

/** The id linking the stalled status to its [Try again] button. */
const PORT_EDIT_STALLED_ID = 'fab-port-edit-stalled';

/** The stalled status + its escape, on one wrapping row so a narrow panel drops
 *  the button below the sentence rather than clipping it. */
const STALLED_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--fab-space-xs)',
};

/** The escape button: a neutral `.fab-tool-btn` (never `.fab-cta` - the build
 *  accent stays reserved for Apply, 51-UI-SPEC A3), and never shrunk by the
 *  wrapping row above. */
const RETRY_BTN_STYLE: CSSProperties = { flexShrink: 0 };

/** A STANDING advisory, and it wraps rather than stretching the panel.
 *
 *  Phase 91 (UI-SPEC Color, A13): at FULL ink. It used to be dim (`--fab-outline`) so
 *  it receded below the rows it qualifies, but that token is 1.64 : 1 on the panel and
 *  fails AA, so no word in the inspector wears it. The caveat still reads as one: it is
 *  plain body text with no control of its own, and the button it qualifies stays live. */
const ADVISORY_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.3,
};

/** The in-flight edit's status - the same geometry as an advisory, at FULL ink.
 *
 *  SINCE PHASE 91 THE TWO STYLES ARE THE SAME DECLARATIONS (review IN-B-02): UI-SPEC A13 put
 *  `ADVISORY_STYLE` at full ink as well, so no word in the inspector wears `--fab-outline`, and
 *  the dim-advisory ranking the history below describes is gone. Two names remain because they
 *  name two roles, a standing caveat and the in-flight edit's status, and a later change to one
 *  role (a status glyph, a tier) must not move the other.
 *
 *  51-UI-REVIEW: `--fab-outline` had been asked to mean four unrelated things at
 *  once - "this group is empty", "this port has no belt", "here is a caveat you
 *  can ignore", and, through the shared advisory style, "every control in this
 *  section just went dead and this sentence is why". The last is the most urgent
 *  message the section can emit and it was rendered in the DIMMEST tier
 *  available, next to a full-contrast `[Try again]` button. That is inverted
 *  hierarchy, and it lands worst in exactly the case that needs it most: when an
 *  edit goes unfolded, this sentence is the only feedback THIS SECTION gives.
 *  (Phase 64 gave refusals their own surface, `#fab-refusal`, and an edit that
 *  stalls without ever being refused gets no sentence there at all - so the
 *  emphasis argument is untouched by it.)
 *
 *  The mechanism was already right - a polite `role="status"`, an honest string,
 *  a tick-bounded stall threshold and an escape. Only the emphasis was wrong, so
 *  only the emphasis changes: full ink, no new tier, no new size, no new token.
 *  (Until phase 91 the standing advisory above stayed dim, which is what restored the
 *  ranking; see the paragraph at the top of this comment.) */
const EDIT_STATUS_STYLE: CSSProperties = { ...ADVISORY_STYLE, color: 'var(--fab-ink)' };

/** Phase 91 (D-12, CHROME-13, UI-SPEC 8.4): what a Factory Out row says when removing
 *  it would drop a belt.
 *
 *  It replaces a standing sentence (51-UI-REVIEW) shown under a Factory's ONLY Out,
 *  docked or not, about the Factory having nowhere to send its results. That one
 *  spoke on every fresh Factory, where removing the output costs nothing a builder
 *  cannot put back with `+ Add output`, and stayed silent on the row where the press
 *  really costs something: a docked Out, whose belt the core releases (`fold_remove_port`,
 *  73-06). This one is shown on exactly that row and no other, and it names the
 *  consequence. One Ctrl+Z puts the output and its belt back (73-06's compensating Dock).
 *
 *  It is the row's note, linked from that row's Remove button by `aria-describedby`.
 *  42 characters, one line at every checked size (UI-SPEC 8.4). */
export const REMOVE_DOCKED_OUTPUT_NOTE = 'Removing this output disconnects its belt.';

/** A blocked remove button points at its reason with this id (per port index, so
 *  several blocked rows never collide). */
const reasonId = (portIndex: number): string => `fab-port-remove-reason-${portIndex}`;

/**
 * A row's Factory-only edit affordance, split across the row's TWO lines: the
 * button belongs on the control line, its note belongs on the line below.
 *
 * Keeping them as one fragment is what produced the horizontal overflow this
 * split fixes (see ROW_STYLE), so the split is expressed in the TYPE rather than
 * left as a convention a later edit could quietly undo.
 */
interface RowControl {
  /**
   * The row's control cluster, IN RENDER ORDER (CONNECT-01). An ordered array
   * rather than a fragment because the ORDER is load-bearing and must be a
   * property of the type rather than of a JSX literal a later edit could quietly
   * reorder: UI-SPEC 2.3's rule is that the FIRST control in the cluster carries
   * `marginLeft: auto` and every later one carries none, so "which is first" is
   * what anchors the pair together at the row's right edge instead of letting
   * flexbox split the free space between two `auto` margins and push them apart.
   *
   * The order is `[Disconnect?, Remove?]`. A row with one control is a
   * one-element cluster whose single member is first - which is what makes every
   * pre-CONNECT-01 row (Remove alone) byte-identical to what it was.
   */
  buttons: JSX.Element[];
  /** The block reason or standing note, on its own line. Absent when the row
   *  has nothing to say (an ordinary, offered removal on a multi-Out Factory). */
  note?: JSX.Element;
}

/**
 * One `role="listitem"` row:
 *
 *   `[silhouette] [label] [status] ... [remove?]`
 *   `[note?]`
 *
 * The accessible name is the COMPOSITE `"{label}, {status}"` (e.g.
 * `"Output - Item, moving"`), because ARIA names a listitem from the author
 * rather than its contents - a contents-only row would be nameless to a screen
 * reader. It is deliberately NOT an `aria-live` region: this text re-derives at
 * ~10Hz and a live region would turn a flowing belt into an SR machine gun
 * (51-UI-SPEC assumption A4).
 *
 * `control` is the Factory-only remove affordance (PANEL-03); every other kind
 * and every non-Out row passes nothing and the row stays exactly as read-only as
 * it was in Plan 01.
 */
function portRow(
  port: PortView,
  flow: Map<number, PortFlow>,
  control?: RowControl,
  label: string = portRowLabel(port),
): JSX.Element {
  const { status, tint, statusColor } = portFlowVisual(flow.get(port.index));
  return (
    <div key={port.index} role="listitem" aria-label={`${label}, ${status}`} style={ROW_STYLE}>
      <div style={ROW_MAIN_STYLE}>
        <span aria-hidden="true" style={{ ...INDICATOR_STYLE, color: tint }}>
          <PortIndicator role={port.role} medium={port.medium} />
        </span>
        <span>{label}</span>
        <span style={{ color: statusColor }}>{status}</span>
        {control?.buttons}
      </div>
      {control?.note}
    </div>
  );
}

/**
 * The per-Out remove control + (on the LAST Out) its inline consequence note.
 *
 * 73-08: THE DOCK-SAFETY GATE IS GONE, AND `busy` IS NOW THE ONLY THING THAT
 * DISABLES THIS BUTTON.
 *
 * Until this phase the control took a block cause from the frontend dock-safety
 * gate (deleted in 73-08) and rendered disabled with a reason whenever removing
 * this Out would have stranded a belt or silently renumbered a later one. That
 * gate existed for ONE reason, stated in its own header: the core's
 * `fold_remove_port` dropped the port and never touched `links`. Plan 73-06 made
 * that sentence false. The fold now re-points every route, dock and default keyed
 * to the removed port and releases exactly the one belt that was on it, and the
 * `RemovePort` inverse emits a compensating `Dock` so one Ctrl+Z puts both the
 * output and its belt back. A gate standing in for an invariant that now exists
 * is worse than useless - it reads as a live safety property and its exact-string
 * test stays green forever - so the module was deleted rather than narrowed.
 *
 * What is left is the loading state, and only that: `busy` alone. The row
 * carries a note when a belt is docked on this Out, which is a CONSEQUENCE to
 * report and never a block (see {@link REMOVE_DOCKED_OUTPUT_NOTE}).
 *
 * @param ordinal 0-based position among the Out ports; the label counts from 1
 *                because "Remove output 1" is what the builder sees, not an
 *                array index.
 * @param docked  A belt is docked on this Out, so removing it releases that belt.
 *                The note slot carries {@link REMOVE_DOCKED_OUTPUT_NOTE}. It does
 *                NOT disable anything: see the constant.
 * @param busy    CR-01: an edit is in flight, so THIS port's packet index is
 *                known-stale. The control goes `disabled` but carries NO reason
 *                element - "the index is momentarily unknown" is a transient
 *                mechanical state, not a fact about this port a reader should be
 *                told (and a reason that flickers for 150ms is SR noise).
 * @param lead    CONNECT-01: is Remove the FIRST control in this row's cluster?
 *                True whenever no Disconnect renders beside it, which is every
 *                row shipped before this phase. Only the leader carries
 *                `marginLeft: auto` (UI-SPEC 2.3) - see
 *                {@link REMOVE_BTN_TRAILING_STYLE}.
 */
function removeControl(
  port: PortView,
  ordinal: number,
  docked: boolean,
  busy: boolean,
  onRemoveOutput: (index: number) => void,
  lead: boolean,
): RowControl {
  const note = docked ? REMOVE_DOCKED_OUTPUT_NOTE : null;
  return {
    buttons: [
      <button
        key="remove"
        type="button"
        className="fab-tool-btn"
        style={lead ? REMOVE_BTN_STYLE : REMOVE_BTN_TRAILING_STYLE}
        aria-label={`Remove output ${ordinal + 1}`}
        aria-describedby={note === null ? undefined : reasonId(port.index)}
        disabled={busy}
        onClick={() => onRemoveOutput(port.index)}
      >
        ×
      </button>,
    ],
    note:
      note === null ? undefined : (
        <span id={reasonId(port.index)} style={ROW_NOTE_STYLE}>
          {note}
        </span>
      ),
  };
}

/**
 * CONNECT-01: the per-DOCKED-PORT disconnect control, or nothing.
 *
 * Built on `removeControl`'s SHAPE with the note half dropped, and the drop is
 * the design rather than an omission. A blocked Remove is visible-but-disabled
 * precisely because it carries a BLOCK REASON a reader has to be told
 * (own-dock / later-dock / unknown). Disconnect has no such story: "is there
 * anything to disconnect here" is answered in full by the row's own status word
 * one span to the left (`not connected` / `idle` / `moving` / `backed up`). So when there
 * is nothing to disconnect this returns `undefined` and the control is ABSENT,
 * never a permanently dead button restating "not connected" as a second, weaker
 * copy of a fact the row already states in words (67-UI-SPEC 2.1).
 *
 * The absence is ALSO the fail-closed half of the link widening: a docked entry
 * whose `link` the join could not resolve offers no verb at all, rather than a
 * button that would have to guess which link it addresses. See `PortFlow.link`.
 *
 * THE LATCH: READ SIDE ONLY, and the missing write side is the SAFE shape rather
 * than a shortcut. Two facts make it safe, both in the `Unlink` validate arm
 * (`command.rs:1410-1478`):
 *
 *   - `Unlink` RE-RESOLVES the port against the live ports
 *     (`view.ports_of(node_id)`) and refuses an index naming no declared port
 *     with `InvalidDock`, so a stale index cannot silently address another port.
 *   - A duplicate `Unlink` of an already-removed link is a DOCUMENTED accepted
 *     no-op, pinned by `unlink_of_an_absent_link_is_accepted_and_folds_to_a_noop`.
 *
 * Contrast the hazard the latch actually exists for, in `App.tsx`'s own words
 * (`App.tsx:681-686`): "`command.rs:855-864` validates a `RemovePort` index by
 * RANGE alone - so a duplicate splices whatever slid into that slot when the
 * first folded". That is the write side's whole purpose and it is UNTOUCHED:
 * `AddPort` and `RemovePort` still arm through `sendPortEdit`. Only Disconnect
 * declines to.
 *
 * WHY ARMING HERE WOULD BE A DEFECT, mechanically. `observePorts`
 * (`portEditLatch.ts`) returns the latch UNCHANGED on its first line whenever
 * `latch.sentPortsKey === portsKey`, and `portsKeyOf` is built from index and
 * role pairs ONLY. An `Unlink` removes a LINK and never a port, so the key is
 * byte-identical either side of the fold: the latch would stay PENDING forever,
 * until `isPortEditStale` crossed `PORT_EDIT_STALL_TICKS` and the panel offered
 * [Try again] for a command that had already succeeded. Every click, every time.
 *
 * A future busy signal for Disconnect would therefore need its OWN release
 * predicate, keyed on the flow map's `docked` or on link identity, never on
 * `portsKeyOf`. That is a separate design decision rather than a reuse, and it is
 * not taken here (67-UI-SPEC 2.4, amended by plan 67-04).
 *
 * @param port         The row's port. Its `index` IS the spatial catalog index
 *                     the emitted `Unlink` carries - the caller reads it from
 *                     here, so the number lives in exactly one place.
 * @param entry        This port's live flow entry (`flow.get(port.index)`).
 * @param busy         CR-01 READ side: a port edit is in flight, so every packet
 *                     index on screen is known-stale and a command keyed on one
 *                     must not be sent. Disconnect does NOT arm that latch - see
 *                     `ConfigPanel.tsx`'s `onDisconnect` for why arming a latch
 *                     an `Unlink` can never release would hang the panel.
 * @param onDisconnect The certified-command seam. It is handed the RESOLVED link
 *                     rather than a port index, because which verb the click
 *                     dispatches is a property of the link's medium (D1).
 */
function disconnectControl(
  port: PortView,
  entry: PortFlow | undefined,
  busy: boolean,
  onDisconnect: (port: PortView, link: PortLink) => void,
  label: string = portRowLabel(port),
): JSX.Element | undefined {
  if (!entry?.docked || entry.link === undefined) {
    return undefined;
  }
  const link = entry.link;
  return (
    <button
      key="disconnect"
      type="button"
      className="fab-tool-btn"
      style={DISCONNECT_BTN_STYLE}
      // Composed, never a bare "Disconnect": a bare name collides across every
      // docked row on the machine, so a by-name query (and a screen reader
      // walking the list) could not tell them apart. Same join the row's own
      // `aria-label` uses.
      aria-label={`${DISCONNECT_LABEL} ${label}`}
      disabled={busy}
      onClick={() => onDisconnect(port, link)}
    >
      {DISCONNECT_LABEL}
    </button>
  );
}

/** The dim `None` row shown when a group has no ports at all. */
function noneRow(): JSX.Element {
  return (
    <div role="listitem" aria-label={EMPTY_GROUP_LABEL} style={NONE_ROW_STYLE}>
      <span>{EMPTY_GROUP_LABEL}</span>
    </div>
  );
}

export interface PortsSectionProps {
  /** The selected node's LIVE packet ports (empty for a portless machine). */
  ports: PortView[];
  /** The machine-kind byte. PANEL-03 add/remove is FACTORY-ONLY (51-CONTEXT
   *  `:23-27`); every other kind renders the list exactly as read-only as before.
   *  Required, not optional, so a caller cannot silently forget it and get the
   *  editing affordances on a Router. */
  kind: number;
  /** PANEL-04: per-port `{docked,count}` keyed by `PortView.index`, derived in
   *  App's ~10Hz poll (`selectedNodePortFlow`). REQUIRED (WR-01): this map is not
   *  just the flow readout, it is the dock-presence input the PANEL-03 remove
   *  gate decides safety from, and "we were handed no dock information" must
   *  never be able to collapse into "nothing is docked". Making it non-optional
   *  is what stops a caller reaching the unsafe default at all; `selectedNodePortFlow`
   *  seeds an entry for EVERY port, so a complete map is always available (the
   *  no-selection case has App's `NO_FLOW` singleton).
   *
   *  A MISSING entry still reads as "not connected" in the row text (the T-51-03
   *  degrade - a readout must never blank or crash), but it reads as DOCKED to
   *  the gate: an unproven port is not a provably-safe one. */
  flow: Map<number, PortFlow>;
  /** PANEL-03: issue an `AddPort { role: Out, medium: Item }` (Factory only). */
  onAddOutput?: () => void;
  /** PANEL-03: issue a `RemovePort { index }` for a PACKET port index (Factory
   *  only, and only ever called from a control the gate left enabled). */
  onRemoveOutput?: (index: number) => void;
  /** CONNECT-01: the CERTIFIED-COMMAND seam for the Disconnect verb. Raised with
   *  the row's `PortView` and the RESOLVED `PortLink`, never with a bare index:
   *  which command the click becomes is a property of the link's medium (D1 - a
   *  belt link is an `Unlink`, a wire link is a `Delete` naming the wire), and
   *  that dispatch belongs to the container that owns the encoder, not to this
   *  presentational list.
   *
   *  Optional, like the two above: a caller with no transport renders the section
   *  with no Disconnect control at all, which is the same absence an undocked
   *  port produces and needs no second story. */
  onDisconnect?: (port: PortView, link: PortLink) => void;
  /** CR-01: an add/remove is IN FLIGHT, so every packet index on screen is
   *  known-stale until the poll delivers the new topology. Disables the whole
   *  Outputs edit group (both remove controls and Add) for that window - App
   *  holds the authoritative guard, this is its visible half.
   *
   *  WR-03: REQUIRED for exactly the reason `flow` two props up is required, and
   *  the reason is worth reading there rather than repeated here. In short: the
   *  optional default would be `false` = "no edit in flight" = the whole
   *  destructive group rendered live, reachable by a caller simply forgetting the
   *  prop, with no type error. `kind` and `flow` - the other two inputs the
   *  remove gate depends on - are already non-optional; this is the third. */
  portEditPending: boolean;
  /** WR-01: the in-flight edit has gone unfolded for `PORT_EDIT_STALL_TICKS` of
   *  SIMULATED time. Swaps the pending status for {@link PORT_EDIT_STALLED} plus
   *  a `[Try again]` button. It does NOT re-enable the edit controls - the latch
   *  is still closed until the user presses that button, because "the sim moved
   *  on without folding this" is not evidence of a rejection and must never be
   *  turned into one silently. */
  portEditStalled: boolean;
  /** Plan 74.1-19 (re-walk J10): the pending status LINE may show. App's
   *  `portEditGrace` controller holds it back for `PORT_EDIT_PENDING_GRACE_MS` after a
   *  send, so a fold that lands inside the grace paints no status text at all (a manual walk saw
   *  the line flash for 59 to 173 ms on every add); a paused sim shows it at once. The
   *  controls are latched by `portEditPending` regardless, and the stalled readout is
   *  rendered regardless. REQUIRED, like `portEditPending`, so a caller cannot silently
   *  bring the flash back or lose the line. */
  portEditPendingVisible: boolean;
  /** WR-01: clear the latch (the user pressed `[Try again]`). Absent means the
   *  escape is not offered at all - which is only correct for a caller that has
   *  no latch to clear, so the shipped panel always passes it. */
  onPortEditReset?: () => void;
  /** CR-01: the sim is paused/draining, so a pending edit is being HELD rather
   *  than merely being slow. Wording only - it changes which pending string is
   *  shown and nothing else, so a stale optimistic value costs a word, never
   *  safety. */
  simPaused?: boolean;
  /** Plan 74.1-19: the host would refuse one more output because a belt is in the
   *  way (`addOutputVerdict` answered `blocked-by-belt` for this machine on the poll
   *  that produced `ports`). Shows {@link ADD_BLOCKED_BY_BELT_NOTE}; never disables the
   *  button. REQUIRED, like `flow`, so a caller cannot silently lose the note. */
  addBlockedByBelt: boolean;
}

/**
 * The grouped I/O list. Pure and told-state (no hooks), like ConfigPanelView -
 * the poll-derived `ports` array and `flow` map plus the two intent callbacks are
 * the only inputs.
 */
export function PortsSection({
  ports,
  kind,
  flow,
  onAddOutput,
  onRemoveOutput,
  onDisconnect,
  portEditPending,
  portEditStalled,
  portEditPendingVisible,
  onPortEditReset,
  simPaused = false,
  addBlockedByBelt,
}: PortsSectionProps): JSX.Element {
  const inputs = ports.filter((p) => p.role === ROLE_IN);
  // The Out group in PACKET ORDER - which IS the Out routing keyspace order that
  // `RemovePort` renumbers, so an ordinal here is a routing key there.
  const outPorts = ports.filter((p) => p.role === ROLE_OUT);
  // Outputs = the Out group, then the Fault group, then anything whose role byte
  // this build does not recognise - all under ONE header. A Fault port IS an
  // output exit, and a phantom "Fault" header on the many kinds that have none
  // would read as a missing feature rather than an absent port.
  //
  // The unknown-role tail is what keeps the open keyspace honest (T-51-01): the
  // role byte is open on the wire, `portLabels` already falls an unrecognised one
  // back to "Output", and a two-way partition would have DROPPED such a port from
  // the panel entirely - a machine listing none of its ports, which is worse than
  // one listing a port under a best-guess heading. It gets no remove control
  // (only `role === Out` does), so an unknown byte can never reach a destructive
  // action. Found by the WR-07 coverage.
  const outputs = [
    ...outPorts,
    ...ports.filter((p) => p.role === ROLE_FAULT),
    ...ports.filter((p) => p.role !== ROLE_IN && p.role !== ROLE_OUT && p.role !== ROLE_FAULT),
  ];

  // PANEL-03 is Factory-only: on every other kind the controls are ABSENT from
  // the DOM entirely (not disabled), because a Router's ports are structural -
  // there is no "blocked" story to tell about them, only "not editable here".
  const editable = kind === machine_kind.FACTORY;
  // 73-08: the three-valued `isDocked` reader that used to sit here went with the
  // dock-safety gate. It existed to feed that gate, which asked whether
  // removing this Out would strand or renumber a docked belt; since 73-06 the core
  // answers that by re-pointing and releasing rather than by refusing, so there is
  // no question left for the panel to fail closed on. Dock presence is still read
  // off `flow` everywhere it is genuinely needed - `addAdvisory` below and
  // `disconnectFor`'s per-row `flow.get(port.index)` - so nothing lost a source of
  // truth; one CONSUMER stopped existing.
  //
  // Plan 74.1-19: would the host refuse one more output because a belt is in the way?
  // App answers that through `addOutputVerdict`, the client mirror of the AddPort
  // validate arm held to the engine's own verdicts; this file only shows it. The
  // 74.1-14 rule that stood here (Out count at least the rot-0 height and a docked
  // Fault) promised a release the host never performs.
  const addAdvisory = editable && addBlockedByBelt;
  // WR-08: the SINGLE condition the Add control and its explanation both read.
  // Deriving both from one expression is what makes "no control" and "no reason"
  // impossible to disagree - previously the control was gated on
  // `editable && onAddOutput` while the note was gated on `!editable` alone, so
  // a Factory with no handler fell through BOTH and said nothing at all.
  const canAdd = editable && onAddOutput !== undefined;
  // Phase 91 (D-12, UI-SPEC 8.4): the fixed-outputs note shows only on a FACTORY with no
  // add handler, where the missing control is the surprise. Every other kind ends its
  // Outputs group at its last row.
  const fixedOutputsNote = editable && !canAdd;

  // Phase 91 (D-12, UI-SPEC 8.6): a ROUTER numbers its Out rows, `Output N - Item`, N its
  // routing key + 1 (the packet order of its Outs, this list's order). The rules editor
  // names its segments `Output N` by the same number, so a rule's target and a row here
  // read as one thing. Every other kind keeps `Output - Item`.
  const numbered = kind === machine_kind.ROUTER;
  const labelOf = (port: PortView): string =>
    numbered && port.role === ROLE_OUT
      ? `${roleLabel(port.role)} ${outPorts.indexOf(port) + 1}${LABEL_SEPARATOR}${mediumLabel(port.medium)}`
      : portRowLabel(port);

  /** CONNECT-01: this row's Disconnect control, or nothing. Gated on `docked` and
   *  a resolvable `link` and on NOTHING else - never on `kind`, never on `role`.
   *  `Unlink`'s field set is `Dock`'s field set exactly, and `Dock` is proven
   *  byte-identical whether it names a belt or a wire, on any role a link can
   *  name (`crates/fabrico-core/tests/draw_wire.rs`), so a control gated narrower
   *  than the command it fires would silently exclude a class of link this phase
   *  exists to close. Remove stays exactly as gated as it was: Out-only and
   *  Factory-only. */
  const disconnectFor = (port: PortView): JSX.Element | undefined =>
    onDisconnect === undefined
      ? undefined
      : disconnectControl(port, flow.get(port.index), portEditPending, onDisconnect, labelOf(port));

  /** A row whose only possible control is the Disconnect: every In row, every
   *  Fault row, and every row whose role byte this build does not recognise.
   *  Remove is not offered on any of them and never was. */
  const disconnectOnly = (port: PortView): RowControl | undefined => {
    const disconnect = disconnectFor(port);
    return disconnect === undefined ? undefined : { buttons: [disconnect] };
  };

  /** The Out row's control cluster: `[Disconnect?, Remove?]` in that order.
   *
   *  A docked, Factory-editable Out carries BOTH, and since 73-08 BOTH are LIVE.
   *  This used to be the row where Remove rendered disabled under "Disconnect it
   *  first" while Disconnect stood enabled beside it, because the core could not
   *  survive removing an Out that carried a link. Plan 73-06 made it survivable:
   *  `fold_remove_port` re-points every route, dock and default keyed to the
   *  removed port and releases exactly the belt that was on it, and the
   *  `RemovePort` inverse emits a compensating `Dock` so one Ctrl+Z restores both.
   *  Disconnect is now a CHOICE the builder has, not a step the panel demands.
   *
   *  The block downgrade that used to sit here (67-REVIEW WR-06) went with the
   *  gate: it existed only to stop the own-dock copy naming a Disconnect that was
   *  not on the row, and there is no block copy left to name anything.
   *
   *  Remove is told whether it LEADS the cluster so exactly one member carries
   *  the auto margin (UI-SPEC 2.3). With Disconnect absent it leads and the row
   *  is unchanged from every row shipped before this phase. */
  const outControl = (port: PortView, ordinal: number): RowControl | undefined => {
    const disconnect = disconnectFor(port);
    if (!editable || !onRemoveOutput) {
      return disconnect === undefined ? undefined : { buttons: [disconnect] };
    }
    // UI-SPEC 8.4: the docked-output note, on a row whose Out carries a belt and on no
    // other row. A wire is never on a Factory's Item output; a docked entry with no
    // resolved link is still docked, so it gets the note too.
    const entry = flow.get(port.index);
    const remove = removeControl(
      port,
      ordinal,
      entry?.docked === true && entry.link?.kind !== 'wire',
      portEditPending,
      onRemoveOutput,
      disconnect === undefined,
    );
    return disconnect === undefined
      ? remove
      : { buttons: [disconnect, ...remove.buttons], note: remove.note };
  };

  return (
    <section
      aria-label="Ports"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}
    >
      {/* Both headers ALWAYS render (structure legibility): a Source's empty
          Inputs group reads as "this machine takes nothing in", which a hidden
          header would leave the reader to infer from absence. */}
      <h3 id={INPUTS_HEADER_ID} style={HEADER_STYLE}>
        Inputs
      </h3>
      <div role="list" aria-labelledby={INPUTS_HEADER_ID} style={LIST_STYLE}>
        {/* CONNECT-01: the Inputs group carries a control for the first time.
            An In port is docked exactly as an Out is, and `Unlink`'s field set is
            role-blind, so gating the verb on role would exclude a class of link
            this phase exists to close. Remove is unaffected: it stays Out-only
            and Factory-only. */}
        {inputs.length === 0 ? noneRow() : inputs.map((p) => portRow(p, flow, disconnectOnly(p)))}
      </div>

      <h3 id={OUTPUTS_HEADER_ID} style={HEADER_STYLE}>
        Outputs
      </h3>
      <div
        role="list"
        aria-labelledby={OUTPUTS_HEADER_ID}
        // QA-02 wall 3: the group POINTS AT its own explanation, so a screen
        // reader hears why there is nothing to add here as part of the Outputs
        // group rather than meeting a stray paragraph after it. The group's NAME
        // (aria-labelledby) is untouched - this only adds a description.
        aria-describedby={fixedOutputsNote ? NON_FACTORY_NOTE_ID : undefined}
        style={LIST_STYLE}
      >
        {outputs.length === 0
          ? noneRow()
          : outputs.map((p) =>
              // `indexOf` over the Out slice gives the ROUTING ordinal; a Fault
              // row is not in that slice (-1) and correctly gets no control.
              // A non-Out row (Fault, or an unrecognised role byte) is not in the
              // Out slice, so it gets no Remove - unchanged. It DOES get a
              // Disconnect when it is docked, for the reason above.
              portRow(
                p,
                flow,
                p.role === ROLE_OUT ? outControl(p, outPorts.indexOf(p)) : disconnectOnly(p),
                labelOf(p),
              ),
            )}
      </div>

      {/* WR-08: on a FACTORY with no add handler the explanation stands in the SLOT
          of the control it explains - after the Outputs list, exactly where `+ Add
          output` renders. Since phase 91 (UI-SPEC 8.4) that is the only case: a
          non-Factory kind's group ends at its last row, because nothing there
          suggests an add control exists to miss.

          EDIT_STATUS_STYLE, not ADVISORY_STYLE (52-UI-SPEC A6): advisory geometry
          at FULL ink, the shipped tier the stalled and pending readouts below
          already use. A dim tier is right for a caveat you may read once and
          ignore; it is wrong for the only thing on screen explaining an absent
          control, which is the inverted hierarchy the 51-UI-REVIEW note above
          corrected. Joining that tier, not inventing one - no new style object. */}
      {fixedOutputsNote && (
        <p id={NON_FACTORY_NOTE_ID} style={EDIT_STATUS_STYLE}>
          {OUTPUT_EDIT_UNAVAILABLE_NOTE}
        </p>
      )}

      {/* PANEL-03 Add: neutral `.fab-tool-btn`, NOT `.fab-cta` - the build accent
          stays reserved for Apply (51-UI-SPEC A3). An AddPort APPENDS, so it can
          never renumber an existing Out's routing key: Add needs no DOCK gate
          where Remove does. It IS latched on the in-flight edit though (CR-01) -
          an unlatched Add turns one impatient double-click into two appends.

          Plan 74.1-19: when the host would refuse the add because a belt is in
          the way, the note says so up front, DIRECTLY ABOVE the button so the two
          read as one unit, and is wired to the button by `aria-describedby`, so
          it is heard, not just seen. The button stays enabled (D-07): the host's
          refusal sentence is the verdict. `revealAddNote` scrolls the pair into
          the panel's view when the note first appears. */}
      {canAdd && onAddOutput && (
        <>
          {addAdvisory && (
            <p id={ADD_ADVISORY_ID} ref={revealAddNote} style={ADVISORY_STYLE}>
              {ADD_BLOCKED_BY_BELT_NOTE}
            </p>
          )}
          <button
            type="button"
            className="fab-tool-btn"
            style={ADD_BTN_STYLE}
            aria-describedby={addAdvisory ? ADD_ADVISORY_ID : undefined}
            disabled={portEditPending}
            onClick={onAddOutput}
          >
            {ADD_OUTPUT_LABEL}
          </button>
        </>
      )}

      {/* CR-01: the latch's own readout. `role="status"` (polite), NOT
          `role="alert"` and NOT the panel's destructive error row - nothing has
          gone wrong, and the panel has no channel that could tell it otherwise.
          It appears once per edit and disappears the moment the fold lands, so it
          is not the ~10Hz SR machine gun the flow rows would be (A4). Since 74.1-19
          it appears only after the grace (`portEditPendingVisible`), so a fold that
          lands quickly never paints it. It sits
          under `editable` rather than under the Add block because a pending
          REMOVE must be explained too. */}
      {editable &&
        portEditPending &&
        (portEditStalled ? (
          // WR-01: the same single `role="status"`, re-worded, plus the escape.
          // The escape exists because the latch is now DURABLE ACROSS REMOUNTS
          // (CR-01): before that, deselecting and reselecting cleared it, so a
          // never-folding edit dead-ended the Outputs group only until the user
          // clicked away. Hoisting the latch without adding this would have
          // converted an escapable dead end into a permanent one, under copy
          // ("Waiting for the host to apply this change.") asserting the change
          // is still coming when nothing is coming at all.
          <div style={STALLED_ROW_STYLE}>
            <p id={PORT_EDIT_STALLED_ID} role="status" style={EDIT_STATUS_STYLE}>
              {PORT_EDIT_STALLED}
            </p>
            {onPortEditReset && (
              <button
                type="button"
                className="fab-tool-btn"
                style={RETRY_BTN_STYLE}
                aria-describedby={PORT_EDIT_STALLED_ID}
                onClick={onPortEditReset}
              >
                {PORT_EDIT_RETRY_LABEL}
              </button>
            )}
          </div>
        ) : (
          // 74.1-19: only once the grace has passed (or at once while paused), so a
          // fast fold paints nothing. The latch above still disables every control
          // from the press.
          portEditPendingVisible && (
            <p role="status" style={EDIT_STATUS_STYLE}>
              {simPaused ? PORT_EDIT_PENDING_PAUSED : PORT_EDIT_PENDING}
            </p>
          )
        ))}
    </section>
  );
}
