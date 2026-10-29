// shortcuts.ts - the one keyboard shortcut table (phase 91, D-11, CHROME-11, research Finding K).
//
// Every key the app binds is one entry here, and three readers use it:
//
//   - the keyboard handlers test a key press through `matchesShortcut` (`input/gestures.ts`
//     `onKey`, and App's Home and Alt listeners), so no handler spells a key of its own;
//   - the Help panel builds every binding that names a key from the entries' `label`s
//     (`chrome/HelpPanel.tsx`), and `HelpPanel.test.tsx` fails if a row drops a cited label or
//     an entry has no row (except the named `HELP_OMITS`);
//   - the toolbar and camera cluster titles that name a key read the same labels.
//
// Before this table the keys were inline literals in two files and the Help copy was typed by
// hand beside them, so Help named a `Fit` button that has no such word, left out Undo, Save and
// Load, and stayed green while it did.
//
// NO BINDING MOVED WITH THE TABLE. Each entry is read off the inline ladder it replaced, with its
// modifiers exactly as that ladder tested them: the Ctrl entries need Ctrl or Cmd (the ladder sat
// under `e.ctrlKey || e.metaKey`), and the others never looked at Ctrl, so they take `'either'`.
// Shift is `'either'` wherever the ladder ignored it, and true or false only where it split two
// actions (Ctrl+Z from Ctrl+Shift+Z, R from Shift+R, Save from Save As).
//
// A PURE MODULE: no React, no DOM, no import. Specs and unit tests import it directly. The one
// outside fact it reads is the platform word for the Ctrl-or-Cmd modifier, once, at load, from
// `navigator.userAgent` when there is one (phase 91 review IN-A-05): the matcher takes Cmd for
// Ctrl, so on macOS the words a user reads say Cmd. `shortcutTable` takes the word as a
// parameter, so a test builds either table without a browser.

/** Which listener owns the key: the gesture controller's `onKey`, or one of App's own. */
export type ShortcutOwner = 'gestures' | 'app';

/** A modifier requirement: held (true), not held (false), or not looked at ('either'). */
export type ModifierRule = boolean | 'either';

export type ShortcutId =
  | 'save'
  | 'saveAs'
  | 'newBoard'
  | 'open'
  | 'undo'
  | 'redo'
  | 'redoY'
  | 'playPause'
  | 'step'
  | 'rotate'
  | 'rotateBack'
  | 'delete'
  | 'escape'
  | 'fit'
  | 'names';

export interface Shortcut {
  readonly id: ShortcutId;
  /** Every `KeyboardEvent.key` value the entry answers to (both cases for a letter). */
  readonly keys: readonly string[];
  /** Ctrl or Cmd (`ctrlKey || metaKey`). */
  readonly ctrl: ModifierRule;
  readonly shift: ModifierRule;
  /** The words a user reads for the key, in Help and in control titles. */
  readonly label: string;
  readonly owner: ShortcutOwner;
}

/** The word a user reads for the Ctrl-or-Cmd modifier. */
export type CtrlWord = 'Ctrl' | 'Cmd';

/** `Cmd` on macOS (its WebKit and Chromium user agents name `Macintosh` or `Mac OS X`), `Ctrl`
 *  everywhere else, the empty string included. */
export function ctrlWordFor(userAgent: string): CtrlWord {
  return /\bMac(intosh| OS X)\b/.test(userAgent) ? 'Cmd' : 'Ctrl';
}

/** The table with every Ctrl entry's label spelled with `ctrl`. Keys, modifiers and owners do not
 *  depend on the word: only the words a user reads do. */
export function shortcutTable(ctrl: CtrlWord): { readonly [K in ShortcutId]: Shortcut & { readonly id: K } } {
  return {
    // Ctrl or Cmd: the file and undo accelerators (gestures.ts, handled before the focus guard).
    save: { id: 'save', keys: ['s', 'S'], ctrl: true, shift: false, label: `${ctrl}+S`, owner: 'gestures' },
    saveAs: { id: 'saveAs', keys: ['s', 'S'], ctrl: true, shift: true, label: `${ctrl}+Shift+S`, owner: 'gestures' },
    newBoard: { id: 'newBoard', keys: ['n', 'N'], ctrl: true, shift: 'either', label: `${ctrl}+N`, owner: 'gestures' },
    open: { id: 'open', keys: ['o', 'O'], ctrl: true, shift: 'either', label: `${ctrl}+O`, owner: 'gestures' },
    undo: { id: 'undo', keys: ['z', 'Z'], ctrl: true, shift: false, label: `${ctrl}+Z`, owner: 'gestures' },
    redo: { id: 'redo', keys: ['z', 'Z'], ctrl: true, shift: true, label: `${ctrl}+Shift+Z`, owner: 'gestures' },
    redoY: { id: 'redoY', keys: ['y', 'Y'], ctrl: true, shift: 'either', label: `${ctrl}+Y`, owner: 'gestures' },
    // The board keys (gestures.ts, after the focus guard).
    playPause: { id: 'playPause', keys: [' '], ctrl: 'either', shift: 'either', label: 'Space', owner: 'gestures' },
    step: { id: 'step', keys: ['.'], ctrl: 'either', shift: 'either', label: '.', owner: 'gestures' },
    rotate: { id: 'rotate', keys: ['r', 'R'], ctrl: 'either', shift: false, label: 'R', owner: 'gestures' },
    rotateBack: { id: 'rotateBack', keys: ['r', 'R'], ctrl: 'either', shift: true, label: 'Shift+R', owner: 'gestures' },
    delete: {
      id: 'delete',
      keys: ['Delete', 'Backspace'],
      ctrl: 'either',
      shift: 'either',
      label: 'Delete or Backspace',
      owner: 'gestures',
    },
    escape: { id: 'escape', keys: ['Escape'], ctrl: 'either', shift: 'either', label: 'Esc', owner: 'gestures' },
    // App's own window listeners (App.tsx): Home fits the view, a held Alt shows the names.
    fit: { id: 'fit', keys: ['Home'], ctrl: 'either', shift: 'either', label: 'Home', owner: 'app' },
    names: { id: 'names', keys: ['Alt'], ctrl: 'either', shift: 'either', label: 'Alt', owner: 'app' },
  };
}

/** This platform's word, read once. Node (the unit suite) and Linux and Windows read `Ctrl`. */
const CTRL_WORD: CtrlWord = ctrlWordFor(typeof navigator === 'undefined' ? '' : navigator.userAgent);

export const SHORTCUTS: { readonly [K in ShortcutId]: Shortcut & { readonly id: K } } = shortcutTable(CTRL_WORD);

/** Every entry, in table order. */
export const SHORTCUT_LIST: readonly Shortcut[] = Object.values(SHORTCUTS);

/**
 * The Ctrl (or Cmd) entries: the accelerators a stopped simulation refuses (phase 90 FAIL-01,
 * D-12). The stopped guard in `gestures.ts` reads this list, so a new accelerator is refused on
 * a stopped board without a second edit.
 */
export const CTRL_SHORTCUTS: readonly Shortcut[] = SHORTCUT_LIST.filter((s) => s.ctrl === true);

/**
 * The entries Help names in no row, each with its reason. Every other entry must be cited by a
 * Help row (`HelpPanel.test.tsx`).
 */
export const HELP_OMITS: ReadonlyArray<{ readonly id: ShortcutId; readonly reason: string }> = [
  {
    id: 'redoY',
    reason: 'Ctrl+Y is a second key for Redo; the Undo / redo row names Ctrl+Shift+Z, as the Redo button title does.',
  },
  {
    id: 'saveAs',
    reason: 'Shift is a modifier on Save; the Save button title states it (Shift for Save As).',
  },
];

/** The fields of a key event the matcher reads (a keydown or a keyup). */
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

function modifierOk(rule: ModifierRule, held: boolean): boolean {
  return rule === 'either' || rule === held;
}

/** True when the event is this entry's key with this entry's modifiers. */
export function matchesShortcut(e: ShortcutEvent, entry: Shortcut): boolean {
  return (
    entry.keys.includes(e.key) &&
    modifierOk(entry.ctrl, e.ctrlKey === true || e.metaKey === true) &&
    modifierOk(entry.shift, e.shiftKey === true)
  );
}
