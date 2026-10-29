// shortcuts.test.ts - the one shortcut table and its matcher (phase 91, D-11, CHROME-11).
//
// Three things are graded here: the matcher takes each entry's keys with its modifiers and
// refuses the other Shift state where Shift splits two actions (threat T-91-20, a refactored
// binding firing a different command); no key press matches two entries; and the table is the
// ladder it replaced, entry by entry, so moving the keys onto the table changed no binding.
// What each entry DOES when pressed is graded in `gestures.test.ts` (the key rig drives every
// entry the gesture controller owns).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CTRL_SHORTCUTS,
  HELP_OMITS,
  SHORTCUTS,
  SHORTCUT_LIST,
  ctrlWordFor,
  matchesShortcut,
  shortcutTable,
  type Shortcut,
  type ShortcutEvent,
} from './shortcuts.ts';

const ev = (key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}): ShortcutEvent => ({
  key,
  ctrlKey: mods.ctrl === true,
  metaKey: mods.meta === true,
  shiftKey: mods.shift === true,
});

/** The event an entry is pressed with: its first key, its required modifiers held. */
const pressOf = (s: Shortcut, key: string = s.keys[0]!): ShortcutEvent =>
  ev(key, { ctrl: s.ctrl === true, shift: s.shift === true });

describe('matchesShortcut', () => {
  it('accepts every key of every entry with its modifiers, and Cmd stands in for Ctrl', () => {
    for (const s of SHORTCUT_LIST) {
      for (const key of s.keys) {
        expect(matchesShortcut(pressOf(s, key), s), `${s.id} on ${JSON.stringify(key)}`).toBe(true);
        if (s.ctrl === true) {
          expect(matchesShortcut(ev(key, { meta: true, shift: s.shift === true }), s), `${s.id} on Cmd`).toBe(true);
        }
      }
    }
  });

  it('refuses the other Shift state where Shift splits two entries', () => {
    expect(matchesShortcut(ev('z', { ctrl: true }), SHORTCUTS.undo)).toBe(true);
    expect(matchesShortcut(ev('z', { ctrl: true, shift: true }), SHORTCUTS.undo)).toBe(false);
    expect(matchesShortcut(ev('Z', { ctrl: true, shift: true }), SHORTCUTS.redo)).toBe(true);
    expect(matchesShortcut(ev('z', { ctrl: true }), SHORTCUTS.redo)).toBe(false);
    expect(matchesShortcut(ev('r'), SHORTCUTS.rotate)).toBe(true);
    expect(matchesShortcut(ev('R', { shift: true }), SHORTCUTS.rotate)).toBe(false);
    expect(matchesShortcut(ev('R', { shift: true }), SHORTCUTS.rotateBack)).toBe(true);
    expect(matchesShortcut(ev('r'), SHORTCUTS.rotateBack)).toBe(false);
    expect(matchesShortcut(ev('s', { ctrl: true }), SHORTCUTS.save)).toBe(true);
    expect(matchesShortcut(ev('S', { ctrl: true, shift: true }), SHORTCUTS.save)).toBe(false);
    expect(matchesShortcut(ev('S', { ctrl: true, shift: true }), SHORTCUTS.saveAs)).toBe(true);
    expect(matchesShortcut(ev('s', { ctrl: true }), SHORTCUTS.saveAs)).toBe(false);
  });

  it('refuses a Ctrl entry pressed without Ctrl or Cmd', () => {
    for (const s of CTRL_SHORTCUTS) {
      for (const key of s.keys) {
        expect(matchesShortcut(ev(key, { shift: s.shift === true }), s), `${s.id} bare ${key}`).toBe(false);
      }
    }
  });

  it('matches no key the entry does not list', () => {
    expect(matchesShortcut(ev('x', { ctrl: true }), SHORTCUTS.save)).toBe(false);
    expect(matchesShortcut(ev('Enter'), SHORTCUTS.escape)).toBe(false);
    expect(matchesShortcut(ev('End'), SHORTCUTS.fit)).toBe(false);
  });

  it('no key press matches two entries, under any Ctrl and Shift state', () => {
    const keys = new Set(SHORTCUT_LIST.flatMap((s) => [...s.keys]));
    for (const key of keys) {
      for (const ctrl of [false, true]) {
        for (const shift of [false, true]) {
          const e = ev(key, { ctrl, shift });
          const hits = SHORTCUT_LIST.filter((s) => matchesShortcut(e, s)).map((s) => s.id);
          expect(hits.length, `${JSON.stringify(key)} ctrl=${ctrl} shift=${shift}: ${hits.join(',')}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('the table is the ladder it replaced (no binding changed, T-91-20)', () => {
  // Read off the inline ladder at PHASE91_START (gestures.ts onKey 6141-6330, App.tsx Home and
  // Alt listeners): the Ctrl block tested `s|S`, `n|N`, `o|O`, `z|Z` (Shift redoes) and `y|Y`
  // under `ctrlKey || metaKey`, Shift ignored except on Z and on Save's `onSave(e.shiftKey)`;
  // the board keys and App's two keys never looked at Ctrl, and only R looked at Shift.
  const LADDER: Record<string, { keys: string[]; ctrl: boolean | 'either'; shift: boolean | 'either' }> = {
    save: { keys: ['s', 'S'], ctrl: true, shift: false },
    saveAs: { keys: ['s', 'S'], ctrl: true, shift: true },
    newBoard: { keys: ['n', 'N'], ctrl: true, shift: 'either' },
    open: { keys: ['o', 'O'], ctrl: true, shift: 'either' },
    undo: { keys: ['z', 'Z'], ctrl: true, shift: false },
    redo: { keys: ['z', 'Z'], ctrl: true, shift: true },
    redoY: { keys: ['y', 'Y'], ctrl: true, shift: 'either' },
    playPause: { keys: [' '], ctrl: 'either', shift: 'either' },
    step: { keys: ['.'], ctrl: 'either', shift: 'either' },
    rotate: { keys: ['r', 'R'], ctrl: 'either', shift: false },
    rotateBack: { keys: ['r', 'R'], ctrl: 'either', shift: true },
    delete: { keys: ['Delete', 'Backspace'], ctrl: 'either', shift: 'either' },
    escape: { keys: ['Escape'], ctrl: 'either', shift: 'either' },
    fit: { keys: ['Home'], ctrl: 'either', shift: 'either' },
    names: { keys: ['Alt'], ctrl: 'either', shift: 'either' },
  };

  it('holds exactly the ladder entries, each with the same keys and modifiers', () => {
    expect(Object.keys(SHORTCUTS).sort()).toEqual(Object.keys(LADDER).sort());
    for (const s of SHORTCUT_LIST) {
      expect({ keys: [...s.keys], ctrl: s.ctrl, shift: s.shift }, s.id).toEqual(LADDER[s.id]);
      expect(SHORTCUTS[s.id].id).toBe(s.id);
    }
  });

  it('the stopped-simulation guard list is the old /^[snozy]$/i accelerators under Ctrl', () => {
    const guarded = new Set(CTRL_SHORTCUTS.flatMap((s) => [...s.keys]));
    expect([...guarded].sort()).toEqual(['N', 'O', 'S', 'Y', 'Z', 'n', 'o', 's', 'y', 'z']);
    for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
      const old = /^[snozy]$/i.test(ch);
      for (const key of [ch, ch.toUpperCase()]) {
        for (const shift of [false, true]) {
          const now = CTRL_SHORTCUTS.some((s) => matchesShortcut(ev(key, { ctrl: true, shift }), s));
          expect(now, `Ctrl+${key} shift=${shift}`).toBe(old);
        }
      }
    }
  });

  it('labels the keys the way the toolbar titles always have', () => {
    expect(SHORTCUTS.undo.label).toBe('Ctrl+Z');
    expect(SHORTCUTS.redo.label).toBe('Ctrl+Shift+Z');
    expect(SHORTCUTS.save.label).toBe('Ctrl+S');
    expect(SHORTCUTS.newBoard.label).toBe('Ctrl+N');
    expect(SHORTCUTS.open.label).toBe('Ctrl+O');
    expect(SHORTCUTS.playPause.label).toBe('Space');
    expect(SHORTCUTS.step.label).toBe('.');
    expect(SHORTCUTS.fit.label).toBe('Home');
    expect(SHORTCUTS.names.label).toBe('Alt');
    expect(new Set(SHORTCUT_LIST.map((s) => s.label)).size).toBe(SHORTCUT_LIST.length);
  });

  // Phase 91 review IN-A-05: the matcher takes Cmd for Ctrl, so on macOS the words say Cmd. The
  // table is built once from the platform's word; every reader (Help, the toolbar and camera
  // titles) reads the labels it holds.
  it('says Cmd on macOS and Ctrl elsewhere, in every Ctrl entry and no other', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0';
    expect([ctrlWordFor(mac), ctrlWordFor(linux), ctrlWordFor(windows), ctrlWordFor('')]).toEqual(['Cmd', 'Ctrl', 'Ctrl', 'Ctrl']);
    const onMac = Object.values(shortcutTable('Cmd'));
    expect(onMac.filter((s) => s.ctrl === true).map((s) => s.label)).toEqual([
      'Cmd+S',
      'Cmd+Shift+S',
      'Cmd+N',
      'Cmd+O',
      'Cmd+Z',
      'Cmd+Shift+Z',
      'Cmd+Y',
    ]);
    const elsewhere = Object.values(shortcutTable('Ctrl'));
    expect(onMac.filter((s) => s.ctrl !== true).map((s) => s.label)).toEqual(
      elsewhere.filter((s) => s.ctrl !== true).map((s) => s.label),
    );
    expect(onMac.map((s) => [s.id, s.keys, s.ctrl, s.shift, s.owner])).toEqual(
      elsewhere.map((s) => [s.id, s.keys, s.ctrl, s.shift, s.owner]),
    );
  });

  it('names its Help omissions by real ids', () => {
    for (const o of HELP_OMITS) {
      expect(SHORTCUTS[o.id]).toBeDefined();
    }
  });
});

// Phase 91 review WR-C03: NO KEYBOARD HANDLER SPELLS A KEY OF ITS OWN, ANYWHERE IN `src/`. D-11's
// promise is that a Help row cannot lie silently, and `HelpPanel.test.tsx` only checks Help against
// this table, so the table must be the only place a binding can live. The scan in `gestures.test.ts`
// covered `gestures.ts` alone and only for keys already in the table: a new `e.key === 'f'` in
// `App.tsx`, or a new handler file, left every suite green with Help silent about it. This scan
// walks every shipped source file (tests and the dev-only `src/spike/` fixtures aside, which never
// reach `dist/`, `check:board`) and sorts each file that registers a keyboard listener or reads a
// `.key` member into exactly one of three named places:
//   - the matcher (`input/shortcuts.ts`), the one reader of `KeyboardEvent.key`;
//   - a table reader, which tests keys only through `matchesShortcut`;
//   - a dialog or popover that owns its keys while open, with the exact keys it reads and why.
// A file in none of them fails, and so does a key read of any other shape in a table reader, or a
// key in a dialog that its entry does not name.
describe('no keyboard handler reads a key outside the table (review WR-C03)', () => {
  const SRC = join(import.meta.dirname, '..');
  const strip = (raw: string): string => raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const shipped = (dir: string, rel = ''): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) return r === 'spike' ? [] : shipped(dir, r);
      return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [r] : [];
    });
  const LISTENER = /(['"`])key(down|up|press)\1|\bonKey(Down|Up|Press)\b/;
  const KEY_READ = /\.key\b|\[\s*(['"`])key\1\s*\]/;
  const MATCHER = 'input/shortcuts.ts';
  /** Files that test keys only through `matchesShortcut`. */
  const TABLE_READERS = ['input/gestures.ts', 'chrome/App.tsx'];
  /** Files that own their keys while they are open, with the keys and the reason. */
  const SCOPED: Record<string, { keys: readonly string[]; reason: string }> = {
    'chrome/DeleteGuardDialog.tsx': { keys: ['Escape', 'Tab'], reason: 'a modal: Escape cancels it and Tab cycles inside it while it is open' },
    'chrome/QuitGuardDialog.tsx': { keys: ['Escape', 'Tab'], reason: 'a modal: Escape cancels it and Tab cycles inside it while it is open' },
    'chrome/ExamplesPopover.tsx': { keys: ['Escape'], reason: 'its own Escape closes the popover and nothing behind it' },
    'chrome/LoadRefusedCard.tsx': { keys: ['Escape'], reason: 'Escape dismisses the card; it is not a modal, so Tab stays free' },
  };
  const files = shipped(SRC);
  const owners = files.filter((f) => {
    const src = strip(readFileSync(join(SRC, f), 'utf8'));
    return LISTENER.test(src) || KEY_READ.test(src);
  });

  it('walks the shipped tree, not an empty list', () => {
    expect(files.length, 'NON-VACUITY: the walk found the shipped sources').toBeGreaterThan(100);
    expect(owners, 'NON-VACUITY: the walk finds the known keyboard owners').toEqual(
      expect.arrayContaining([MATCHER, ...TABLE_READERS, ...Object.keys(SCOPED)]),
    );
  });

  it('every file with a keyboard listener or a key read is the matcher, a table reader or a named dialog', () => {
    const named = new Set([MATCHER, ...TABLE_READERS, ...Object.keys(SCOPED)]);
    expect(owners.filter((f) => !named.has(f)), 'a keyboard owner this test does not name').toEqual([]);
  });

  it('a table reader reads KeyboardEvent.key only through matchesShortcut', () => {
    for (const f of TABLE_READERS) {
      const src = strip(readFileSync(join(SRC, f), 'utf8'));
      expect(src, `${f}: no \`.key\` read on any name`).not.toMatch(/\.key\b/);
      expect(src, `${f}: no ['key'] index`).not.toMatch(/\[\s*(['"`])key\1\s*\]/);
      expect(src, `${f}: no { key } destructured from an event`).not.toMatch(/\{[^{}]*\bkey\b[^{}]*\}\s*(=|:\s*(KeyboardEvent|Pick)\b|\))/);
      expect(src, `${f}: reads the table`).toMatch(/matchesShortcut\(\s*\w+\s*,\s*SHORTCUTS\./);
    }
  });

  it('a dialog reads only the keys its entry names, each as a plain comparison', () => {
    for (const [f, { keys, reason }] of Object.entries(SCOPED)) {
      expect(reason.length, `${f}: carries a reason`).toBeGreaterThan(0);
      const src = strip(readFileSync(join(SRC, f), 'utf8'));
      const reads = src.match(/\.key\b/g) ?? [];
      const compares = [...src.matchAll(/\b\w+\.key\s*===\s*(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
      expect(compares.length, `${f}: every \`.key\` read is a comparison with a literal`).toBe(reads.length);
      expect([...new Set(compares)].sort(), `${f}: reads exactly the keys its entry names`).toEqual([...keys].sort());
    }
  });
});
