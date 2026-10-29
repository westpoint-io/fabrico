// HelpPanel.tsx - the collapsible "?" gesture-reference panel (ONB-03).
//
// A `.fab-panel` key toggled from the Toolbar "?" Help button, mirroring the
// Legend contract EXACTLY: CLOSED by default (App owns `helpOpen` and mounts
// this only while open; the button carries `aria-expanded` + `aria-controls`
// pointing at HELP_PANEL_ID). It lists what a user can do on the board and how
// (placing, belts, the Wire tool, delete, undo, the file keys, the camera and the
// transport) as a two-column gesture|binding table, so a user can operate the
// board without guessing. Every string renders as a React text child (no innerHTML).
//
// THE ROWS ARE CHECKED AGAINST THE APP, NOT AGAINST A COPY (phase 91, D-11, CHROME-11,
// UI-SPEC 8.3). Every binding that names a key is built from the one shortcut table the
// keyboard handlers read (`input/shortcuts.ts`), and each row lists the entries it
// documents in `cites`; `HelpPanel.test.tsx` fails if a row drops a cited label or a table
// entry has no row (bar the named `HELP_OMITS`). The mouse rows (pan, zoom, the zoom %
// reset, the corner-brackets Fit button) are not keys: they were read off `camera.ts` and
// `CameraCluster.tsx`, and `e2e-live/13-help-panel.spec.ts` drives them on the real host.
//
// It docks top-right, below the Toolbar, at the shared dock offset. That used to be
// justified as "opposite the bottom-left Legend, so the two panels never collide (UI-SPEC
// Pitfall 6)", which stopped being true in 52-06: the Legend is a BOTTOM STRIP now, and at
// 1024x768 with both open Help covered 344 x 137.5 px of it. Since phase 92 (CHROME-12, D-05)
// Help stops 8 px above the open strip and scrolls in the room left (the max height below). All colour reads
// `--fab-*` tokens; no canvas state accent is borrowed as decoration; text rides the Phase
// 47 vector tokens (Martian Mono body via `--fab-font`). No em dash.

import type { CSSProperties, JSX } from 'react';
import { SHORTCUTS, type ShortcutId } from '../input/shortcuts';
import { CAMERA_CLUSTER_CLEARANCE } from './CameraCluster';

/** Help's top in the container, the shared dock offset: lg 24 + min-target 44 + 2xl 48 = 116. */
const DOCK_TOP = '(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))';
/** The ring padding above and below Help's content: 2 * (sm 8 + ring 6) = 28. */
const RING_PADDING_Y = '2 * (var(--fab-space-sm) + var(--fab-bezel-ring))';
/**
 * From the open Legend's top to the most Help's CONTENT may reach: Help's top, its ring padding top
 * and bottom (panels are content-box, `chromeCss.ts`), and the 8 px gap it keeps above the strip,
 * the same `--fab-space-sm` the cluster clearance keeps. 116 + 28 + 8 = 152.
 */
const LEGEND_BOUND_OFFSET = `${DOCK_TOP} + ${RING_PADDING_Y} + var(--fab-space-sm)`;
/** The content floor: Help's heading line, 18 px at line height 1.2, and the 8 px gap the column
 *  keeps under it (29.6; phase 92 review IN-B-05: the heading alone left the content 8 px taller than
 *  the box, over the bezel). Below it, outside the supported sizes, Help may cross the strip
 *  (UI-SPEC A11) rather than lose its own heading. */
const HEADING_FLOOR = 'calc(var(--fab-font-size-hero) * 1.2 + var(--fab-space-sm))';

/** The Help panel's stable DOM id - the Toolbar "?" button aria-controls it. */
export const HELP_PANEL_ID = 'fab-help-panel';

/** The heading id - the `<aside>` aria-labelledby points at it (under the h1). */
const HELP_HEADING_ID = 'fab-help-heading';

/**
 * One gesture-reference row: the action, its binding, and the shortcut table entries the
 * binding names (empty for a row that names no key).
 */
interface GestureRow {
  gesture: string;
  binding: string;
  cites: readonly ShortcutId[];
}

/** A key's words, read from the shortcut table. */
const k = (id: ShortcutId): string => SHORTCUTS[id].label;

// UI-SPEC 8.3, in its order. Imports the pure shortcut table, the camera cluster's clearance
// constant and React types. Exported so the colocated node test checks the rows directly.
export const GESTURE_ROWS: readonly GestureRow[] = [
  // Palette rows are native buttons, so Enter on a focused row arms it (the browser's key,
  // not a table entry).
  { gesture: 'Arm a tool', binding: 'Click a palette item, or Enter', cites: [] },
  // Placement commits on the floor click; only the Label tool lets go after one.
  { gesture: 'Place', binding: 'Click the floor; machine tools stay armed', cites: [] },
  { gesture: 'Cancel / disarm', binding: `${k('escape')}, right-click, or click the tool again`, cites: ['escape'] },
  // A label never turns (phase 76, D-04).
  {
    gesture: 'Rotate',
    binding: `${k('rotate')} (${k('rotateBack')} turns the other way)`,
    cites: ['rotate', 'rotateBack'],
  },
  // A BELT, drawn with the Belt tool. `wire` is the cable tool's word (the row below), so a
  // belt is never called a wire. Phase 89 lets the draw run either way; Help names the usual one.
  { gesture: 'Draw a belt', binding: 'Belt tool: drag an output to an input', cites: [] },
  // 52-UI-SPEC R3: the two CHAIN rows sit inside the build cluster, as its continuation.
  {
    gesture: 'Extend the flow',
    binding: 'Place the next machine, then draw a belt from the one before it',
    cites: [],
  },
  // 74-UI-SPEC 6.1 and the 74.1 gap closure (review WR-02): the join starts on the floor tile
  // JUST PAST the belt end; a press on the end tile itself is a red no-op. It says "belt end",
  // never "Head" (6.3).
  { gesture: 'Join two belts', binding: 'With the Belt tool, press just past a belt end and draw on', cites: [] },
  // Phase 89 (D-05): no tool and no selection; the output dot docks onto a belt's start.
  { gesture: 'Connect to a belt', binding: "Drag an output dot onto a belt's start", cites: [] },
  // The Wire tool presses a Route's electrical Out and releases on an HTTP Handler's In.
  { gesture: 'Wire a Route', binding: 'Wire tool: drag a Route to an HTTP Handler', cites: [] },
  // Quotes PortsSection's ADD_OUTPUT_LABEL; HelpPanel.test.tsx imports the constant and checks
  // this binding contains it, so renaming the real control fails there.
  { gesture: 'Add an output', binding: 'Select a Factory, then + Add output', cites: [] },
  { gesture: 'Delete', binding: `Select, then ${k('delete')}`, cites: ['delete'] },
  { gesture: 'Undo / redo', binding: `${k('undo')} / ${k('redo')}`, cites: ['undo', 'redo'] },
  {
    gesture: 'Save / load / new',
    binding: `${k('save')} / ${k('open')} / ${k('newBoard')}`,
    cites: ['save', 'open', 'newBoard'],
  },
  // A left drag on empty floor pans while no tool is armed (`camera.ts` pan enable), middle
  // drag always pans, a trackpad scroll pans.
  {
    gesture: 'Pan',
    binding: 'Drag empty floor with no tool armed, middle-drag, or two-finger scroll',
    cites: [],
  },
  // A plain mouse wheel zooms too; the cluster has no zoom in or out buttons.
  { gesture: 'Zoom', binding: 'Mouse wheel, Ctrl + scroll, or pinch', cites: [] },
  { gesture: 'Reset zoom', binding: 'Click the zoom % at bottom right', cites: [] },
  // Home and the Fit button are one action (both call doFit), so one row. The button is an
  // icon of four corner brackets with no word on it, so the row names what it shows.
  { gesture: 'Fit to factory', binding: `${k('fit')}, or the corner-brackets button`, cites: ['fit'] },
  { gesture: 'Show names', binding: `Hold ${k('names')}, or the Names button`, cites: ['names'] },
  { gesture: 'Play / pause', binding: k('playPause'), cites: ['playPause'] },
  { gesture: 'Step one tick', binding: k('step'), cites: ['step'] },
];

// UI-SPEC 8.3 layout (phase 91, D-11): both cells at line height 1.4, so a wrapped 12 px line
// has a 16.8 px pitch and its descenders never touch the next line's ascenders (at 1 they did).
const cellStyle: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1.4,
};

/** The gesture cell never wraps: the column is as wide as its widest action (17ch). */
const gestureStyle: CSSProperties = {
  ...cellStyle,
  whiteSpace: 'nowrap',
};

/** The binding cell adds tabular figures (mono) so the reference reads cleanly. */
const bindingStyle: CSSProperties = {
  ...cellStyle,
  fontVariantNumeric: 'tabular-nums',
};

/**
 * The scroll box's attribute: a focused element carrying it keeps its own keys (Space, Home, the
 * arrows, Page Up and Down, End), so the board's Space and App's Home stand down for it as they
 * do for a focused button (`gestures.ts` `onKey`, App's Home listener; review WR-B-05).
 */
export const HELP_SCROLL_ATTR = 'data-fab-help-scroll';

/**
 * Make the scroll box a tab stop only while its list scrolls (UI-SPEC 7.3, review WR-B-05): a box
 * with nothing to scroll is a stop that does nothing. A ref callback with a ResizeObserver, the
 * hook-free shape `observeBadgeTruncation` in `Toolbar.tsx` uses; the box and its one child are
 * observed, so a window resize and a content change both re-check.
 */
function observeScrollFocus(box: HTMLDivElement | null): (() => void) | undefined {
  if (box === null) return undefined;
  const check = (): void => {
    if (box.scrollHeight > box.clientHeight) box.tabIndex = 0;
    else box.removeAttribute('tabindex');
  };
  check();
  if (typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(check);
  observer.observe(box);
  if (box.firstElementChild !== null) observer.observe(box.firstElementChild);
  return () => observer.disconnect();
}

export function HelpPanel(): JSX.Element {
  return (
    <aside
      id={HELP_PANEL_ID}
      className="fab-panel"
      aria-labelledby={HELP_HEADING_ID}
      style={{
        position: 'absolute',
        // Docked top-right, below the Toolbar, at the shared dock offset (116 px). The panel is
        // deliberately NOT a `data-fab-corner-dock`: it is a top-docked surface, so reserving its
        // whole width from the bottom strip would narrow the strip to solve a vertical brush.
        top: 'calc(var(--fab-space-lg) + var(--fab-min-target) + var(--fab-space-2xl))',
        right: 'var(--fab-space-lg)',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-sm)',
        // Ring padding (plan 59-03): the 6px the retired border reserved.
        padding: 'calc(var(--fab-space-sm) + var(--fab-bezel-ring))',
        // As wide as the grid plus the list's 24 px scrollbar room (17ch + 16 + 44ch + 24 = 528 px of
        // content, UI-SPEC 8.3, UI review item 5, the phase 91 re-certification); the old 420 px
        // cap made most bindings wrap.
        //
        // THE HEIGHT HAS TWO BOUNDS, AND THE NEARER ONE WINS. The camera cluster: Help stops 8 px
        // above its top, as the inspector does (review WR-B-06, UI review item 1): 116 top + 104
        // clearance + 28 padding = 248 off the container's height. It stopped 24 px above the
        // window's bottom edge (168) until then, and the cluster painted over its last rows. And,
        // since phase 92 (CHROME-12, D-05), the open Legend: Help stops 8 px above the strip's top,
        // which App's band measurement writes as `--fab-legend-top` (container px) in the same
        // layout pass the strip moves in, so no painted frame shows Help over it; 152 off that top
        // (LEGEND_BOUND_OFFSET). With the Legend closed the property is absent and the fallback, far
        // below any window, leaves the cluster bound alone. Below either bound the list scrolls in
        // its own box, which is then a tab stop (`observeScrollFocus`).
        //
        // TWO ALTERNATIVES WERE REJECTED (D-05). Marking Help a `data-fab-corner-dock`, the
        // inspector's route, would make the band reserve its 556 px: the strip would be 198 px at
        // 1024 wide, under its 240 px minimum, and the Legend would refuse to open. And making Help
        // and the Legend shut each other is simpler but hides one to show the other.
        width: 'fit-content',
        maxHeight: `min(calc(100% - ${DOCK_TOP} - ${CAMERA_CLUSTER_CLEARANCE} - ${RING_PADDING_Y}), max(${HEADING_FLOOR}, calc(var(--fab-legend-top, 100000px) - (${LEGEND_BOUND_OFFSET}))))`,
      }}
    >
      {/* A real <h2> under the Toolbar <h1> (no skipped level), mirroring Legend:
          Sono title tier (.fab-title) at the hero size. */}
      <h2
        id={HELP_HEADING_ID}
        className="fab-title"
        style={{
          margin: 0,
          fontSize: 'var(--fab-font-size-hero)',
          color: 'var(--fab-ink)',
          lineHeight: 1.2,
        }}
      >
        Gestures
      </h2>

      {/* The rows' scroll box (UI-SPEC 7.3). It scrolls only on a window too short for the list,
          and only then is it a tab stop (`observeScrollFocus`), so the list can be scrolled from
          the keyboard; its focus ring is the one CHROME_CSS rule this phase adds. While it has
          focus, Space and Home scroll it (`HELP_SCROLL_ATTR`). `minHeight: 0` lets the flex
          column shrink it below its content.

          THE RIGHT PADDING IS ROOM FOR AN OVERLAY SCROLLBAR (phase 91 UI review item 5).
          WebKitGTK's scrollbar takes no layout width and paints over the box's right edge, and the
          44ch binding column ended exactly on that edge, so the Pan row's `middle-` ran under the
          scrollbar at 1024x640 (measured in WebKitGTK 2.54.1: the text's right edge equal to the
          box's, at 1024x640 and at 1083x677 under GDK_DPI_SCALE 1.1818). Under the pointer the bar
          widens to span 6 to 15 px in from the edge, so an 8 px room left `middle-` under the
          hovered bar (the phase 91 re-certification walk on the real app). `--fab-space-lg` keeps
          every line 24 px clear, 9 px past the hovered bar; the panel is `fit-content`, so it
          grows by the room. */}
      <div
        data-fab-help-scroll=""
        ref={observeScrollFocus}
        style={{ overflowY: 'auto', minHeight: 0, paddingRight: 'var(--fab-space-lg)' }}
      >
        {/* Two-column gesture|binding table; the grid keeps the bindings aligned. The binding
            column is 44ch, so only the three longest bindings wrap, onto two lines each. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content 44ch',
            columnGap: 'var(--fab-space-md)',
            rowGap: 'var(--fab-space-xs)',
            alignItems: 'baseline',
          }}
        >
          {GESTURE_ROWS.map((row) => (
            <div key={row.gesture} style={{ display: 'contents' }}>
              <span style={gestureStyle}>{row.gesture}</span>
              <span style={bindingStyle}>{row.binding}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
