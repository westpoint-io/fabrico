// Palette.tsx - the machine palette (UI-SPEC "React Chrome Layout", left edge).
//
// A floating vertical panel of machine entries. Each entry pairs an inline
// machine icon (icons.tsx MachineGlyphIcon - the parametric chassis from
// `machineChassis.ts` plus the SAME authored `render/assets/*.svg` the Pixi machine
// tessellates, so palette and canvas draw one asset rather than two that agree)
// with a text label, at a 44px-min interactive target. Clicking an entry ARMS it
// (IX-10, click to arm): it hands the MachineKind u8 to the gesture controller
// (07-09 gestures.ts), which drives the build ghost, and a click on the floor places
// it and emits the logged Place - the palette never touches grid state itself.
//
// CHROME-01 / CHROME-02: no vector icon library, no inline vector markup; every
// colour/spacing/font is a --fab-* token (no theme.ts, no hand-authored hex);
// labels are Martian Mono at the 12px base in var(--fab-ink) (the raised ink
// passes AA normal text, so no large-text bracket applies);
// hover raises the glyph + label to the lit edge (build accent is reserved for
// CTA/focus/selection, never palette hover).

import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { machine_kind } from '../protocol/kinds';
import { MEDIUM_MECHANICAL } from '../protocol/ports';
import { KIND_NAMES } from './kindNames';
import { SIM_STOPPED_COPY } from './SimStoppedCard';
import { LabelIcon, MachineGlyphIcon, WireIcon } from './icons';
import { ICON_LG_PX } from '../render/synth/chrome/iconSizes';

interface MachineEntry {
  kind: number;
  label: string;
  /**
   * SHELL-06 role tooltip: functional, role-describing `title` copy (what the
   * machine DOES), not the old thin `Place ${label}`. The `aria-label` keeps the
   * `Place ${label}` accessible name (do not regress screen-reader naming); this
   * `role` string is the hover tooltip only. Authored with hyphens/parens, never
   * an em dash (project copy rule).
   */
  role: string;
}

/**
 * SHELL-04 palette glyph size, now the shared `--fab-icon-lg` step.
 *
 * NOTE, CORRECTED IN PLACE BY PLAN 59-01 (CHROME-01). This used to read: "Size the
 * glyph to the base label cap-height (~11px) so palette icon and label read at the same
 * height; 11px over the 11-cell GLYPH_BOX is a crisp 1px/cell." Both halves died with
 * the raster. There is no `GLYPH_BOX` and no cell any more - the glyph is a vector on a
 * 32u grid - so "1px per cell" describes nothing, and matching the label's cap height
 * was a proxy for crispness that a vector reaches differently: its floor is its THINNEST
 * STROKE reaching one whole CSS pixel, which 11px misses (a 2u detail stroke lands at
 * 0.69 px). The derivation for 16 and 24 lives on `iconSizes.ts`, in one place, rather
 * than being re-argued at each call site.
 *
 * The Palette takes the LARGER step because its icon now draws the chassis too, and the
 * chassis eats the outer 4u plus half a 3u stroke on every side - leaving a 24u interior
 * in which a 1x1 subject's ~12u motif renders at 9.0 px, which is exactly what today's
 * 11px bare glyph renders its 9x9 motif at. Identification legibility is held CONSTANT.
 *
 * `.fab-palette-item` keeps `min-height: var(--fab-min-target)` (44px), and MEASURED
 * (plan 59-01, task 3) that min-height still dominates at 24px: the row's content box is
 * `24 + 2 * 8 padding + 2 * 1 border = 42px`, under the 44px floor, so the Palette does
 * not grow at all. The +117px of height the UI-SPEC costed against WINDOWS id 2 does not
 * materialise, and the remedy ladder written for it was never reached.
 */
const PALETTE_GLYPH_PX = ICON_LG_PX;

/**
 * The armed tool surfaced from gestures.ts (`onArmedChange`) into React - a
 * machine kind, the Belt tool, the Wire tool, or nothing. Structurally identical to the
 * `GestureDeps.onArmedChange` payload so App can pass `setArmed` straight in.
 * Exactly one tool is armed at a time (the gesture layer enforces it), so the
 * palette derives at most one `.is-armed` item from this.
 */
export type ArmedTool =
  // `presetMedium` is set ONLY for a ROUTE-06 Router preset (Electrical=1 HTTP,
  // Mechanical=0 Item); absent/null for a plain machine placement. It lets the
  // palette light the SPECIFIC armed preset even though both presets share
  // machineKind = ROUTER (IX-03 exactly-one-armed).
  | { kind: 'machine'; machineKind: number; presetMedium?: number | null }
  | { kind: 'belt' }
  // The Wire tool (WIRE-02, plan 66-01). Like the Belt tool it carries no payload:
  // a wire is drawn nub to nub and there is nothing to pick beforehand.
  | { kind: 'wire' };

/**
 * ROUTE-06 Router presets (36-05): a preset is a palette row over the ONE
 * `Node::Router` engine, carrying the `Port.medium` the host should seed. It arms
 * `machine_kind.ROUTER` via `gestures.beginRouterPreset(medium)` and the host seeds
 * the typed ports once the Place echoes (plan 36-03). This REPLACES a bare generic
 * Router entry - a router is always placed AS a preset.
 *
 * TWO presets shipped from 36-05 until 72-10, which PULLS the Electrical one. The
 * TYPE keeps its `medium` field and the `.map` keeps its shape, because the mechanism
 * is what places the surviving Mechanical Router at all and the medium is still the thing
 * being carried. See `ROUTER_PRESETS` for why the row went.
 */
interface RouterPreset {
  medium: number;
  label: string;
  /** SHELL-06 role tooltip (hyphens/parens, never an em dash - project copy rule). */
  role: string;
}
// ROUTE-04 (65-06), THE NAMED COST OF THE PRESENT WORDING.
//
// These two role strings used to read `Routes requests by rule (wire ports)` and
// `Routes items by rule (belt ports)`. The parenthetical was, at that time, the ONLY
// place in the palette that stated which MEDIUM each preset seeds, and dropping it is
// a recorded decision rather than a regression for someone to rediscover:
//
//   - The medium distinction SURVIVES in the port rows. `portRowLabel`
//     (`portLabels.ts`) renders `Output - Wire` for an Electrical port and
//     `Output - Item` for a Mechanical one, on the selected node's live packet ports,
//     and the Legend carries the same vocabulary.
//   - The two lines still differ from each other on the noun: `requests` for the HTTP
//     preset, `items` for the Item preset. That one word is what distinguishes the
//     presets in the palette once the parenthetical is gone, which is why the strings
//     are copied verbatim from the phase contract and never paraphrased.
//
// WHY THE NEW LINES ARE TRUE OF A ROUTER A USER CAN ACTUALLY PLACE.
//
// CORRECTED 2026-08-22 (post-phase code review). THE JUSTIFICATION ORIGINALLY WRITTEN
// HERE WAS FALSE, and it is worth naming rather than quietly replacing, because the
// same false claim is in `65-CONTEXT.md` and it is what the copy decision rested on.
// It said: "a fresh Router starts with an EMPTY routing table and no default ... so a
// fresh Router faults every item until the user writes a rule."
//
// WHAT THE ENGINE ACTUALLY DOES. `crates/fabrico-core/src/tick.rs:313` mints a Router
// as `add_router(Vec::new(), Some(0))` - an empty table, but a default of ROUTING KEY
// 0, not `None`. `Router::step` (`crates/fabrico-core/src/router.rs:48-52`) finds no
// matching rule, takes the `default` branch, and pushes the item to output 0. So a
// freshly placed Router sends EVERY item to its FIRST OUTPUT. It faults nothing. An
// item is faulted only if the user clears the default to `None (fault)` themselves.
//
// THE COPY IS STILL RIGHT, ON THE CORRECT GROUND. A fresh Router sends everything ONE
// WAY and SPLITS NOTHING until the user writes a rule, so `Splits ... by rules you
// write` promises exactly the thing the machine cannot do yet and attributes it to the
// user, who is the one who makes it true. The old lines (`Routes requests by rule`)
// were the false ones: they described branching behaviour of a machine that branches
// nothing and, until this phase, had no editor to write a rule in at all.
//
// The other half of the truth - where an unmatched item actually goes - is carried by
// the panel's always-present fallthrough line (`RouterConfigBody.tsx`), which reads the
// LIVE default off the node. On a fresh Router that renders `fallthroughTo(cell)`,
// naming the real world cell of output 0; it renders `FALLTHROUGH_FAULT` only when the
// default is genuinely unset. The panel was always correct. Only this rationale was
// wrong.
//
// `Palette.test.tsx` pins the surviving string verbatim AND asserts the rules editor
// is reachable from `ConfigPanel` for a Router config, so deleting the editor turns
// this copy red rather than leaving it quietly false again.
//
// ================================ 72-10 (R-64) ================================
// THE ELECTRICAL PRESET ROW IS PULLED, AND ONE ENTRY IS ALL THAT IS LEFT.
//
// The row read `HTTP Router / Splits requests by rules you write` and it was a LIVE
// FALSE CLAIM about a machine that cannot do the job at all. Nothing ever links a
// machine's OUTPUT port into a wire - `crates/fabrico-core/src/tick.rs:652-653`
// creates only the one link, from the request's entry - so a Router structurally
// cannot sit on a request path. Its byte-offset match rule would also break after 128
// requests, as the correlation varint widens past one byte.
//
// PULLED RATHER THAN CORRECTED, because there is no TRUE sentence available for a
// machine that cannot do the job. A corrected row would advertise a Router the user
// can place onto a wire graph where it will silently do nothing, which is the exact
// defect class phase 72 exists to close.
//
// AND PULLED IS THE DEFAULT, not a preference. A judgement item whose default is
// "keep" ships the false claim if the verdict comes back blank; defaulting to pull
// inverts that, so a blank verdict removes a false sentence. It is one line to put
// back with a corrected role if that is the call at the walk.
//
// IF YOU ARE HERE BECAUSE YOU FOUND A ONE-ENTRY `ROUTER_PRESETS` AND WONDERED: this
// paragraph is the reason, and the preset MACHINERY is deliberately kept for the one
// survivor. It exists because two mediums share one `Node::Router` engine and the
// host seeds the typed ports on echo; that is still how the Router is placed.
// ==============================================================================
//
// ONE NAME (phase 91, CHROME-09, D-09). The row used to hand-write a longer two-word
// label, so the palette was the one surface that did not say what the board's name
// tag, the inspector heading and the Legend row say. It reads the shared map now, like
// every row in `ENTRIES`. `Place Route` is a prefix of `Place Router`, so a locator
// that means one of them matches by exact name.
const ROUTER_PRESETS: RouterPreset[] = [
  { medium: MEDIUM_MECHANICAL, label: KIND_NAMES[machine_kind.ROUTER], role: 'Splits items by rules you write' },
];

// The click-to-PLACE machine entries (order per UI-SPEC line 193). BELT is NOT here
// - a belt is not a placeable machine (the core rejects Place{BELT}, 17-02); the
// Belt tool is a separate DrawBelt-only entry appended below.
//
// READ-01: each entry's `label` reads from the shared KIND_NAMES map so the
// palette, the canvas Alt-hold chips, and the Legend never drift. The label
// value is byte-for-byte the same string it always was (Source/Sink/…), so the
// `aria-label="Place ${label}"` accessible names and the getByRole readiness
// contract stay UNCHANGED - this is a single-source refactor, not a rename.
const ENTRIES: MachineEntry[] = [
  { kind: machine_kind.SOURCE, label: KIND_NAMES[machine_kind.SOURCE], role: 'Emits items into the factory' },
  { kind: machine_kind.SINK, label: KIND_NAMES[machine_kind.SINK], role: 'Consumes items (the drain)' },
  { kind: machine_kind.FACTORY, label: KIND_NAMES[machine_kind.FACTORY], role: 'Transforms items (runs your code)' },
  { kind: machine_kind.TEE, label: KIND_NAMES[machine_kind.TEE], role: 'Splits one input two ways' },
  { kind: machine_kind.BALANCER, label: KIND_NAMES[machine_kind.BALANCER], role: 'Evenly balances flow across outputs' },
  // ROUTER is not a plain ENTRY - it is listed as the ROUTER_PRESETS row below,
  // rendered right after this map so it keeps its list position.
  { kind: machine_kind.MERGE, label: KIND_NAMES[machine_kind.MERGE], role: 'Merges inputs into one output' },
  // ROUTE + HTTP HANDLER (72-10). The two machines a request actually travels
  // through, in the order it meets them: it arrives at the Route and is answered by
  // the Handler. They sit as an adjacent PAIR for that reason, and the pair reads
  // top-to-bottom the way the traffic does.
  //
  // THEY ARE ORDINARY ENTRIES NOW, AND THAT IS THE POINT OF D-10. The Route's row
  // used to be HAND-WRITTEN below this array, and the reason it gave was that every
  // entry here reads its label from `KIND_NAMES` while kind 9 was deliberately kept
  // outside that map. The map now names every kind, so the reason is gone and the
  // row comes home. A hand-written row kept beside a reason that stopped being true
  // is the same defect D-10 closed one layer up.
  //
  // BOTH ARM PLAIN `onBeginPlacement`, WITH NO PRESET MACHINERY. The Router's presets
  // exist only because two mediums share one `Node::Router` engine; each of these is
  // ONE catalog kind landing from ONE `Place` record (D-11), which is the whole
  // reason this phase never calls `RemovePort`. `beginPlacement` feeds
  // `ghost.setPlacement(kind, 0)` -> `catalogEntry(kind)`, so the placement ghost
  // previews each machine's real nubs, including the Handler's electrical squares.
  //
  // GLYPHS: `MachineGlyphIcon` resolves `SUBJECT_OF` - kind 9 to the authored
  // `endpoint.svg`, kind 10 to `factory.svg` (a Handler IS a Factory chassis). NO NEW
  // ARTWORK IS NEEDED AND NONE MAY BE ADDED.
  //
  // THE `role` STRINGS ARE A BINDING, NOT DECORATION. `e2e/palette-grouping.spec.ts`
  // asserts that every `aside button[aria-label^="Place "]` carries a title that does
  // NOT begin with `Place `, so a row shipped without role copy reddens that spec.
  { kind: machine_kind.ENDPOINT, label: KIND_NAMES[machine_kind.ENDPOINT], role: 'Receives HTTP requests at a path you choose' },
  { kind: machine_kind.HANDLER, label: KIND_NAMES[machine_kind.HANDLER], role: 'Runs your JavaScript on a request and returns the reply' },
];

export interface PaletteProps {
  /** Arm a machine for placement (the MachineKind u8) - handled by gestures.ts. */
  onBeginPlacement: (kind: number) => void;
  /**
   * Arm DrawBelt-only draw mode (the Belt tool). A belt is DRAWN (click-drag an
   * orthogonal path) + DOCKED, never PLACED - this is a dedicated entry point, NOT
   * a `Place(BELT)` sentinel routed through `onBeginPlacement` (17-02 rejects
   * Place{BELT}). Wired to `gestures.armBeltDraw`.
   */
  onArmBeltDraw: () => void;
  /**
   * Arm DrawWire-only draw mode (the Wire tool). A wire is DRAWN nub to nub
   * (press an electrical Out nub, drag, release on an In nub => one `DrawWire`),
   * never PLACED - the same shape as the Belt tool and for the same reason.
   * Wired to `gestures.armWireDraw`.
   */
  onArmWireDraw: () => void;
  /**
   * Arm a ROUTE-06 Router preset by its seeded medium (Electrical=1 HTTP,
   * Mechanical=0 Item) - wired to `gestures.beginRouterPreset`. Placing seeds the
   * typed ports over the ONE `Node::Router` engine (plan 36-03).
   */
  onBeginRouterPreset: (medium: number) => void;
  /**
   * The currently armed tool (from gestures.ts `onArmedChange`), or null. Drives
   * the visibly-armed `.is-armed` state + `aria-pressed` on exactly one item
   * (IX-03); persists regardless of hover.
   */
  armed: ArmedTool | null;
  /**
   * FAIL-01 (phase 90, D-12, UI-SPEC 1.4): the host's sim loop has ended, so nothing placed or
   * drawn could reach it. Every item renders `disabled`, titled `SIM_STOPPED_COPY.disabledTitle`,
   * with the inline flat look the `Webhook not ready` field uses (no new selector). Accessible
   * names are unchanged. Optional; absent is false.
   */
  disabled?: boolean;
}

/** The look of a palette item that cannot be used: the `.fab-tool-btn:disabled` and `Webhook not
 *  ready` desaturate, inline, and the not-allowed cursor. */
const ITEM_DISABLED_STYLE = { filter: 'saturate(0) brightness(0.8)', cursor: 'not-allowed' } as const;

/**
 * The bottom edge of the Toolbar header band, as a CSS length built from the SAME tokens
 * the header is built from (phase 76): it sits `--fab-space-lg` from the top, and its one
 * row of `--fab-min-target` controls is padded `--fab-space-sm + --fab-bezel-ring` above
 * and below (`Toolbar.tsx`). 96px with the locked tokens. `palette-grouping.spec.ts`
 * MEASURES the header and asserts the Palette clears it at three viewports, so a header
 * that changes height without this line moving reddens there rather than hiding the
 * Palette's heading under the toolbar again.
 */
const HEADER_BAND_BOTTOM =
  'calc(var(--fab-space-lg) + 2 * (var(--fab-space-sm) + var(--fab-bezel-ring)) + var(--fab-min-target))';

/**
 * THE TOOL LIST AND ITS SCROLL CUE (phase 91, CHROME-16, D-15). The list scrolls when the band
 * below the header is shorter than the column, and the overlay scrollbar draws nothing until it
 * is used, so the list used to look finished at 1280x720 and below (91-MEASURE.md). While the
 * list can scroll further down, it carries `data-more-below` and a 24px fade
 * (`--fab-space-lg`) lies on its bottom edge, from transparent to the panel fill, taking no
 * pointer events so the row under it still arms. The toggle is computed in script on the list's
 * `scroll`, a `ResizeObserver` of the list and of each row, the fonts settling and window
 * `resize`, not by a scroll-driven
 * animation, so it works in WebKitGTK. The fade reaches the opaque fill 2px above the edge, so
 * the edge itself reads exactly the panel fill (UI-SPEC section 6, its pixel check).
 *
 * A component of its own, declared here rather than in a new chrome file, so `Palette()` stays
 * hook-free and its unit tests keep calling it as a plain function: the rows arrive as
 * `children` and the plain-function tree still holds every one of them.
 */
export function PaletteToolList({ children }: { children: ReactNode }): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el === null) {
      return undefined;
    }
    const measure = (): void => {
      setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    // THE ROWS ARE WATCHED TOO (review IN-B-06). Once the list is at its max height a row that
    // grows (a late web-font swap that changes the row height, a row added) changes how far it
    // can scroll without resizing the list's own box and without a scroll event, so watching the
    // box alone left the attribute stale until the user scrolled. Each row is observed, a row
    // added or removed is picked up by the MutationObserver, and the fonts settling re-measures.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const watchRows = (): void => {
      if (observer === null) return;
      observer.disconnect();
      observer.observe(el);
      for (const row of Array.from(el.children)) observer.observe(row);
    };
    watchRows();
    const rows = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      watchRows();
      measure();
    });
    rows?.observe(el, { childList: true });
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      rows?.disconnect();
    };
  }, []);
  return (
    <div
      // Takes the list's place in the palette column: shrinks with it when the band is short.
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div
        ref={listRef}
        data-testid="palette-tools"
        data-more-below={moreBelow ? '' : undefined}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--fab-space-xs)',
          minHeight: 0,
          overflowY: 'auto',
          scrollbarWidth: 'thin',
        }}
      >
        {children}
      </div>
      {moreBelow ? (
        <div
          data-fab-palette-fade=""
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 'var(--fab-space-lg)',
            pointerEvents: 'none',
            background: 'linear-gradient(to bottom, transparent, var(--fab-panel-fill) calc(100% - 2px))',
          }}
        />
      ) : null}
    </div>
  );
}

export function Palette({
  onBeginPlacement,
  onArmBeltDraw,
  onArmWireDraw,
  onBeginRouterPreset,
  armed,
  disabled = false,
}: PaletteProps): JSX.Element {
  const offTitle = disabled ? SIM_STOPPED_COPY.disabledTitle : undefined;
  const offStyle = disabled ? ITEM_DISABLED_STYLE : undefined;
  const beltArmed = armed?.kind === 'belt';
  // Byte-identical derivation to `beltArmed` above. It is DERIVED and not a prop,
  // so the Wire row costs no new plumbing beyond `onArmWireDraw`.
  const wireArmed = armed?.kind === 'wire';
  return (
    <aside
      // LAYOUT CONTRACT (52-06): App measures this element's right edge and hands
      // it to `Legend` as `paletteRightPx`, so the bottom Legend strip starts to
      // the right of this column instead of covering its lower tools.
      data-fab-left-dock=""
      className="fab-panel"
      style={{
        position: 'absolute',
        left: 'var(--fab-space-lg)',
        // CENTRED IN THE BAND BELOW THE HEADER (phase 76), not in the whole window. The
        // twelfth row (the Label tool and its separator, 53px) made the centred column
        // 688.78px tall, and centred in the WHOLE window its heading slid under the
        // toolbar at the shipped 1280x800 window (and the old gesture hint box too at 1280x720;
        // at 720 the heading was already under it before this phase). Centred in the band
        // [header bottom, window bottom] the column clears the header at every height,
        // and `maxHeight` caps it to that band less an `--fab-space-xs` margin each side,
        // so when the band is too short the TOOL LIST scrolls (below) instead of the
        // panel running under the header or off the bottom of the window. MEASURED: at
        // 1280x800 the whole column fits with no scroll, 7.6px clear of the header (taken
        // with the old gesture hint box still in the column; at 1280x720 and 1024x768 the
        // list scrolls and the heading stays put).
        top: `calc(50% + ${HEADER_BAND_BOTTOM} / 2)`,
        transform: 'translateY(-50%)',
        maxHeight: `calc(100% - ${HEADER_BAND_BOTTOM} - 2 * var(--fab-space-xs))`,
        // So `maxHeight` bounds the PANEL, ring padding included, not just its content.
        boxSizing: 'border-box',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-xs)',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
        width: 'fit-content',
      }}
      aria-labelledby="fab-palette-heading"
    >
      {/* SHELL-06 heading: a short-noun label for the placeable-machine group. An
          <h2> sits correctly under the Toolbar <h1> (no skipped level) and names
          the aside landmark (aria-labelledby). Sono title tier (.fab-title) at the
          hero size, so every panel title reads as ONE tier (Phase 47 D-02/D-08). */}
      <h2
        id="fab-palette-heading"
        className="fab-title"
        style={{
          margin: 0,
          fontSize: 'var(--fab-font-size-hero)',
          color: 'var(--fab-ink)',
          lineHeight: 1.2,
          // Never squeezed: when the band is short, the tool list scrolls instead.
          flexShrink: 0,
        }}
      >
        Machines
      </h2>
      {/* THE TOOL LIST (phase 76). Every row and both separators, in a column with the
          SAME `--fab-space-xs` gap the panel used before, so at a window tall enough for
          the whole column the layout is the one it always was. When the band below the
          header is shorter than the column (1280x720, 1024x768) THIS box scrolls and the
          heading above it stays put: every tool stays reachable without the
          panel sliding under the toolbar or off the window. `PaletteToolList` (below)
          owns the box and its scroll cue (CHROME-16), so this function stays hook-free. */}
      <PaletteToolList>
        {ENTRIES.map((e) => {
          const isArmed = armed?.kind === 'machine' && armed.machineKind === e.kind;
          return (
          <button
            key={e.kind}
            type="button"
            className={isArmed ? 'fab-palette-item is-armed' : 'fab-palette-item'}
            title={offTitle ?? e.role}
            aria-label={`Place ${e.label}`}
            aria-pressed={isArmed}
            // IX-10: arm on click AND Enter/Space (native <button> semantics),
            // replacing the mouse-only onPointerDown. Arming emits nothing - the
            // gesture layer commits one Place on the subsequent canvas click.
            onClick={() => onBeginPlacement(e.kind)}
            // A mouse press must NOT focus the item: a focused chrome button traps
            // the canvas keyboard shortcuts (Esc-to-disarm, r) behind the IX-09
            // focus guard. preventDefault on mousedown suppresses mouse focus while
            // leaving Tab focus + Enter/Space arming (IX-10) fully intact.
            onMouseDown={(ev) => ev.preventDefault()}
            disabled={disabled}
            style={offStyle}
          >
            {/* color=currentColor so the inline SVG glyph (icons.tsx: no raster, no mask)
                inherits the item ink and raises to the lit edge on hover (via
                .fab-palette-item / :hover). */}
            <span className="fab-glyph">
              <MachineGlyphIcon kind={e.kind} color="currentColor" px={PALETTE_GLYPH_PX} />
            </span>
            <span style={{ whiteSpace: 'nowrap' }}>{e.label}</span>
          </button>
          );
        })}
        {/* ROUTE-06 (36-05): the Router preset over the ONE Node::Router engine.
            Same `.fab-palette-item` component + ROUTER glyph as the machines above
            (no new visual language); it arms machine_kind.ROUTER tagged with its
            preset medium, and the host seeds the typed ports on echo. Highlighted by
            (machineKind ROUTER + presetMedium) so exactly the armed preset lights.

            ONE preset since 72-10, not two: the electrical `HTTP Router` row is PULLED
            as a false claim (see `ROUTER_PRESETS` above for the engine reason). The
            `.map` stays rather than being flattened to a single row, because the preset
            machinery is what places the Router at all and a one-element map is the
            honest shape of "one preset survives" - a flattened row would read as though
            the mechanism had been removed too. */}
        {ROUTER_PRESETS.map((preset) => {
          const isArmed =
            armed?.kind === 'machine' &&
            armed.machineKind === machine_kind.ROUTER &&
            armed.presetMedium === preset.medium;
          return (
            <button
              key={`router-preset-${preset.medium}`}
              type="button"
              className={isArmed ? 'fab-palette-item is-armed' : 'fab-palette-item'}
              title={offTitle ?? preset.role}
              aria-label={`Place ${preset.label}`}
              aria-pressed={isArmed}
              onClick={() => onBeginRouterPreset(preset.medium)}
              onMouseDown={(ev) => ev.preventDefault()}
              disabled={disabled}
              style={offStyle}
            >
              <span className="fab-glyph">
                <MachineGlyphIcon kind={machine_kind.ROUTER} color="currentColor" px={PALETTE_GLYPH_PX} />
              </span>
              <span style={{ whiteSpace: 'nowrap' }}>{preset.label}</span>
            </button>
          );
        })}
        {/* SHELL-06 grouping: a hairline separator divides the placeable machines
            (above) from the two DRAWN tools below - the Belt tool (DrawBelt) and the
            Wire tool (DrawWire) - because neither is PLACED. role="separator" gives
            the divide accessible semantics. The `data-testid` still reads
            `palette-belt-divider` DELIBERATELY: it is an e2e selector asserted at
            toHaveCount(1) in palette-grouping.spec.ts, so only this comment moved. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          data-testid="palette-belt-divider"
          style={{
            alignSelf: 'stretch',
            height: 1,
            // Phase 76: inside the scrolling tool list a 1px flex item would SHRINK
            // to nothing when the list overflows, and the group divide would vanish.
            flexShrink: 0,
            margin: 'var(--fab-space-xs) 0',
            background: 'var(--fab-outline)',
          }}
        />
        {/* The Belt tool ARMS DrawBelt-only draw mode (REND-04): a belt is DRAWN
            (click-drag an orthogonal path, route()-preview build-blue/red, release
            => one DrawBelt) + DOCKED, never Placed. It is a dedicated entry - NOT a
            Place(BELT) sentinel - since the core rejects Place{BELT} (17-02). */}
        <button
          key="belt-tool"
          type="button"
          className={beltArmed ? 'fab-palette-item is-armed' : 'fab-palette-item'}
          // 52-UI-SPEC.md:142 (R1) SUPERSEDES the earlier "belt copy is not
          // migrated" pin, for this `title` ATTRIBUTE ONLY: the Palette is the one
          // permanently-visible surface, so its hover help names the JOB belts do
          // ("connect machines") rather than only the gesture that draws them.
          // NOTE this string doubles as an e2e SELECTOR; the call sites in
          // frontend/e2e{,-live} match it by the `Draw belts` PREFIX for that
          // reason (see e2e/palette-grouping.spec.ts), so appending or re-tailing
          // this copy is safe while re-leading it is not.
          title={offTitle ?? 'Draw belts to connect machines (click-drag a path)'}
          aria-pressed={beltArmed}
          // IX-10: arm on click AND Enter/Space (native <button> semantics). The
          // visible "Belt" label and the ABSENCE of an aria-label are unchanged and
          // out of contract (52-UI-SPEC.md:146): the accessible name stays the
          // visible "Belt" text, pinned by the Phase 32 getByRole readiness suite.
          onClick={() => onArmBeltDraw()}
          // Same mouse-focus suppression as the machine items (see above).
          onMouseDown={(ev) => ev.preventDefault()}
          disabled={disabled}
          style={offStyle}
        >
          <span className="fab-glyph">
            <MachineGlyphIcon kind={machine_kind.BELT} color="currentColor" px={PALETTE_GLYPH_PX} />
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>Belt</span>
        </button>
        {/* The Wire tool ARMS DrawWire-only draw mode (WIRE-02, plan 66-01). It sits
            BELOW the separator directly after the Belt tool because a wire is DRAWN,
            not PLACED, which is the separator's stated job. Press an electrical Out
            nub, drag (the orthogonal corridor the landed cable will take is previewed
            live), release on an In nub => exactly one `DrawWire`. The user chooses
            WHICH ports connect; the host auto-routes the L between them. */}
        <button
          key="wire-tool"
          type="button"
          className={wireArmed ? 'fab-palette-item is-armed' : 'fab-palette-item'}
          // Mirrors the Belt tool's title shape: the JOB first, the gesture in
          // parentheses. NOTE this string doubles as an e2e SELECTOR; the call sites
          // in frontend/e2e{,-live} match it by the `Draw wires` PREFIX (see
          // e2e-live/support/oracle.ts `drawWireBetweenPorts`), so appending or
          // re-tailing this copy is safe while re-leading it is not.
          title={offTitle ?? 'Draw wires to carry requests (drag from one highlighted port to another)'}
          aria-pressed={wireArmed}
          // IX-10: arm on click AND Enter/Space (native <button> semantics). Like the
          // Belt tool, the visible "Wire" label IS the accessible name and there is
          // deliberately NO aria-label (52-UI-SPEC.md:146).
          onClick={() => onArmWireDraw()}
          // Same mouse-focus suppression as every other row.
          onMouseDown={(ev) => ev.preventDefault()}
          disabled={disabled}
          style={offStyle}
        >
          <span className="fab-glyph">
            {/* THE FIRST PALETTE ROW TO DRAW A CHROME GLYPH rather than a
                MachineGlyphIcon, and that is deliberate rather than drift. The Belt
                row above renders `MachineGlyphIcon kind={machine_kind.BELT}` and gets
                away with it only because MachineGlyphIcon carries an explicit
                `isBelt` special case. `SUBJECT_OF` has no key for kind 8 (WIRE), so
                `MachineGlyphIcon kind={8}` would draw a bare chassis with nothing
                inside it. `WireIcon` wraps ChromeGlyphIcon instead, which is what a
                wire is: a link, not a machine box. */}
            <WireIcon color="currentColor" px={PALETTE_GLYPH_PX} />
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>Wire</span>
        </button>
        {/* Phase 76 (SHAPE-10, UI-SPEC 1.1): a SECOND hairline separator, and below it the
            Label row in a group of its own. Every row above the first separator places a
            machine and the two below it draw links; a note is neither, and a row inside the
            machine group would read as a machine by default. The separator is a copy of the
            first one with its own test id; `palette-grouping.spec.ts` counts both. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          data-testid="palette-label-divider"
          style={{
            alignSelf: 'stretch',
            height: 1,
            // Phase 76: inside the scrolling tool list a 1px flex item would SHRINK
            // to nothing when the list overflows, and the group divide would vanish.
            flexShrink: 0,
            margin: 'var(--fab-space-xs) 0',
            background: 'var(--fab-outline)',
          }}
        />
        {/* The Label row arms placement of kind 11 through the SAME `onBeginPlacement` every
            machine row uses (D-02: a label is built through the same command path). Visible
            text `Label`, accessible name `Place Label` (the shipped `Place ${label}` shape,
            read from the ONE name map like every machine row),
            and a role tooltip that does NOT begin with `Place `. The tool lets go after one
            placement (UI-SPEC U-4); the gesture layer owns that, not this row. */}
        <button
          key="label-tool"
          type="button"
          className={
            armed?.kind === 'machine' && armed.machineKind === machine_kind.LABEL
              ? 'fab-palette-item is-armed'
              : 'fab-palette-item'
          }
          title={offTitle ?? 'A note on the board. It does not connect.'}
          aria-label={`Place ${KIND_NAMES[machine_kind.LABEL]}`}
          aria-pressed={armed?.kind === 'machine' && armed.machineKind === machine_kind.LABEL}
          onClick={() => onBeginPlacement(machine_kind.LABEL)}
          // Same mouse-focus suppression as every other row.
          onMouseDown={(ev) => ev.preventDefault()}
          disabled={disabled}
          style={offStyle}
        >
          <span className="fab-glyph">
            <LabelIcon color="currentColor" px={PALETTE_GLYPH_PX} />
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>{KIND_NAMES[machine_kind.LABEL]}</span>
        </button>
      </PaletteToolList>
    </aside>
  );
}
