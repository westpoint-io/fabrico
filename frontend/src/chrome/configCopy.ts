// configCopy.ts - the shared copy module: the config panel's "not applied" words (phase 90,
// D-05, CHROME-17), the guards' words for edits queued on a paused board (review WR-B-03) and
// the empty board's words (phase 91, D-10, CHROME-10).
//
// Two words used to mean the same thing on screen at once. The toolbar's `Unsaved` badge
// says the BOARD differs from its file; the panel's heading marker said "unsaved" too, about
// config typed into a panel and not yet sent to the host, which no Save would ever write. Since
// D-05 "saved" and "unsaved" belong to the board file only (the badge and the guard dialogs,
// unchanged), and config the panel holds but has not applied is "not applied".
//
// A SEPARATE PURE MODULE, NO IMPORTS (the `dirtyState.ts` discipline). The live helper
// (`e2e-live/support/oracle.ts`) and the Playwright specs import these words instead of
// spelling them, so a later rename cannot leave a check grading words that no longer render
// (research Finding J). A Playwright spec cannot load `ConfigPanel.tsx` itself: its icon
// imports reach `.svg` files only Vite can load (research Finding F). So the words live here,
// and `ConfigPanel.tsx` imports and renders them. `configCopy.test.ts` pins both literals.

/** The heading marker beside the kind name while the panel holds typed, unapplied config. */
export const CONFIG_NOT_APPLIED_MARKER = '• not applied';

/** The last sentence of the Factory code error row (`Handler error - <error>. Not applied.`). */
export const CONFIG_NOT_APPLIED_SUFFIX = 'Not applied.';

// ---------------------------------------------------------------------------
// EDITS QUEUED ON A PAUSED BOARD (phase 90 review WR-B-03 and WR-C-10, walk todo 2026-10-24 "New
// before Play drops a paused Apply without a warning"). A paused host holds every edit until Play,
// so nothing has been accepted and the `Unsaved` badge stays off (D-03), but New, Open, an example
// or quit would drop them with the old board. The guards ask, and say so. Here, not in
// `QuitGuardDialog.tsx`, so the live and mock specs grade the words they render.
// ---------------------------------------------------------------------------

/** The words every queued-edits guard sentence holds; the specs grade them. */
export const GUARD_QUEUED_WORDS = 'edits queued on the paused board';

/** The guard's sentence when the only work the action would lose is edits queued on the paused board. */
export const GUARD_QUEUED_BODY = {
  quit: 'You have edits queued on the paused board. If you quit now, they will be lost.',
  new: 'You have edits queued on the paused board. If you start a new board now, they will be lost.',
  open: 'You have edits queued on the paused board. If you open another board now, they will be lost.',
  example: 'You have edits queued on the paused board. If you load an example now, they will be lost.',
} as const;

/** Added after the unsaved-edits sentence when edits are also queued on the paused board. */
export const GUARD_QUEUED_TOO = 'So will the edits queued on the paused board.';

/** Added on a guard that offers Save while edits are queued: the host saves the board without them. */
export const GUARD_QUEUED_SAVE_NOTE = 'Saving now does not keep the queued edits: press Play first, then save.';

// ---------------------------------------------------------------------------
// THE EMPTY BOARD (phase 91, D-10, CHROME-10, UI-SPEC 8.2). The hint used to say "Drag" a
// machine from the palette and "load the demo scene"; the palette arms on a click and places
// on a floor click, and the demo moved into the Examples popover. Here, not in `App.tsx`, so
// the mock and live specs import the words the app renders instead of retyping them.
// ---------------------------------------------------------------------------

/** The empty board's heading (`.fab-title` draws it upper case). */
export const EMPTY_FLOOR_HEADING = 'Empty factory floor';

/** The empty board's body: the two gestures that place a machine, the Belt tool, and Examples. */
export const EMPTY_FLOOR_BODY =
  'Click a machine in the palette, then click the floor to place it. Connect machines with the Belt tool, or open Examples to load a ready-made factory.';

// ---------------------------------------------------------------------------
// PORT ROWS (phase 91, D-12, CHROME-13, UI-SPEC 8.5). A port row used to read `{n} moving`,
// an item count, and a jammed belt read `12 moving` while nothing on it could move. A row now
// says what its belt is doing in one of four words, read from the render packet's facts
// (`protocol/portFlow.ts`): nothing docked, docked and still, docked and carrying items, or a
// docked belt whose head slot holds an item that cannot leave. Here, not in `PortsSection.tsx`,
// so the mock and live specs import the words the panel renders.
// ---------------------------------------------------------------------------

/** The four port row status words. No count appears in a row. */
export const PORT_STATUS = {
  notConnected: 'not connected',
  idle: 'idle',
  moving: 'moving',
  backedUp: 'backed up',
} as const;

/** One of the four port row status words. */
export type PortStatus = (typeof PORT_STATUS)[keyof typeof PORT_STATUS];
