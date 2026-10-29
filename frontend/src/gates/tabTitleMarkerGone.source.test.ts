// THE GUARD THAT KEEPS THE DEAD TAB TITLE MARKER GONE (phase 90, plan 90-01, CHROME-05, D-04).
//
// Until phase 90 `setDirty` in `src/chrome/App.tsx` prefixed the browser tab title with a star and
// a space while the board was unsaved. In the shipped app nobody saw it: WebKitGTK under Tauri does
// not mirror the page title into the native window title, and nothing calls the Tauri window API
// (90-MEASURE.md `## CHROME-05`). The toolbar `Unsaved` badge is the one unsaved cue. This gate
// fails if App.tsx writes the tab title again or a comment describes a title prefix again, and
// (review IN-B-07) if any other shipped source under `frontend/src` names the tab title.
//
// Read as source, comments included, never imported. The forbidden tokens are built from parts so
// a search of the tree for them finds App.tsx only, never this file.
// Seen red before the fix: run against App.tsx at PHASE90_START (90-EVIDENCE.md, `D14
// case=CHROME-05`).

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../chrome/App.tsx', import.meta.url));
const SRC = fileURLToPath(new URL('..', import.meta.url));

/**
 * Review IN-B-07: every shipped source file under `frontend/src` (`.ts` and `.tsx`, tests left
 * out), not App.tsx alone, so a tab title write added in any other module fails this gate too.
 */
function shippedSources(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...shippedSources(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/** The tab title property access. */
const TITLE_ACCESS = ['document', 'title'].join('.');
/** The double-quoted star-space prefix literal the old comments quoted. */
const STAR_PREFIX = ['"', '* ', '"'].join('');
/** The words the old comments used for the title prefix. */
const PREFIX_WORDS = [['title', 'in', 'lockstep'].join(' '), ['window', 'title'].join('-')];

function count(src: string, token: string): number {
  return src.split(token).length - 1;
}

describe('the tab title carries no unsaved marker (CHROME-05)', () => {
  const src = readFileSync(APP, 'utf8');

  it('reads the real App.tsx (anti-vacuity: the file is there and holds setDirty)', () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain('setDirty');
  });

  it('App.tsx never writes or reads the browser tab title', () => {
    expect(count(src, TITLE_ACCESS)).toBe(0);
  });

  it('App.tsx holds no star-space title prefix literal', () => {
    expect(count(src, STAR_PREFIX)).toBe(0);
  });

  it('no comment in App.tsx describes a title prefix', () => {
    for (const words of PREFIX_WORDS) expect(count(src, words), words).toBe(0);
  });
});

describe('no shipped source writes the browser tab title (CHROME-05, review IN-B-07)', () => {
  const files = shippedSources();

  it('reads the real source tree (anti-vacuity: App.tsx and well over a hundred files)', () => {
    expect(files).toContain(APP);
    expect(files.length).toBeGreaterThan(100);
  });

  it('no shipped source file names the tab title', () => {
    const hits = files.filter((f) => count(readFileSync(f, 'utf8'), TITLE_ACCESS) > 0).map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
