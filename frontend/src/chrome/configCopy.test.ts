// configCopy.test.ts - the one place the config panel's not-applied words are pinned as
// literals (phase 90, D-05, CHROME-17, research Finding J). Every other check imports the
// constants, so a copy edit moves the panel and every check at once, and this file is where it
// is seen.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_NOT_APPLIED_MARKER,
  CONFIG_NOT_APPLIED_SUFFIX,
  EMPTY_FLOOR_BODY,
  EMPTY_FLOOR_HEADING,
  PORT_STATUS,
} from './configCopy.ts';

/** U+2014, built from its code point so this file carries none itself. */
const EM_DASH = String.fromCharCode(0x2014);

describe('configCopy - the panel says "not applied", the board says "unsaved" (D-05)', () => {
  it('the heading marker is exactly "• not applied"', () => {
    expect(CONFIG_NOT_APPLIED_MARKER).toBe('• not applied');
  });

  it('the Factory error suffix is exactly "Not applied."', () => {
    expect(CONFIG_NOT_APPLIED_SUFFIX).toBe('Not applied.');
  });

  it('neither word says "saved": that word belongs to the board file', () => {
    for (const words of [CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX]) {
      expect(words.toLowerCase(), words).not.toContain('saved');
    }
  });

  it('the module imports nothing and carries no em dash', () => {
    const src = readFileSync(fileURLToPath(new URL('./configCopy.ts', import.meta.url)), 'utf8');
    expect(src.split('\n').filter((line) => /^\s*import\b/.test(line)), 'configCopy.ts is a pure module').toEqual([]);
    expect(src.includes(EM_DASH), 'configCopy.ts carries no U+2014').toBe(false);
    for (const words of [CONFIG_NOT_APPLIED_MARKER, CONFIG_NOT_APPLIED_SUFFIX]) {
      expect(words.includes(EM_DASH), words).toBe(false);
    }
  });
});

describe('configCopy - the empty board says the gestures that work (phase 91, D-10, CHROME-10)', () => {
  it('the heading is exactly "Empty factory floor" (UI-SPEC A21: unchanged)', () => {
    expect(EMPTY_FLOOR_HEADING).toBe('Empty factory floor');
  });

  it('the body is the UI-SPEC 8.2 sentence pair, 149 characters', () => {
    expect(EMPTY_FLOOR_BODY).toBe(
      'Click a machine in the palette, then click the floor to place it. Connect machines with the Belt tool, or open Examples to load a ready-made factory.',
    );
    expect(EMPTY_FLOOR_BODY.length).toBe(149);
  });

  it('the body names click, the palette, the Belt tool and Examples', () => {
    for (const word of ['Click', 'palette', 'Belt tool', 'Examples']) {
      expect(EMPTY_FLOOR_BODY, word).toContain(word);
    }
  });

  it('the body says neither "Drag" nor "demo scene", and neither word carries an em dash', () => {
    expect(EMPTY_FLOOR_BODY).not.toContain('Drag');
    expect(EMPTY_FLOOR_BODY).not.toContain('demo scene');
    for (const words of [EMPTY_FLOOR_HEADING, EMPTY_FLOOR_BODY]) {
      expect(words.includes(EM_DASH), words).toBe(false);
    }
  });
});


describe('configCopy - port rows read as state words, never a count (phase 91, D-12, CHROME-13)', () => {
  it('the four words are exactly the UI-SPEC 8.5 words', () => {
    expect(PORT_STATUS).toEqual({
      notConnected: 'not connected',
      idle: 'idle',
      moving: 'moving',
      backedUp: 'backed up',
    });
  });

  it('no word carries a digit, a period or an em dash', () => {
    for (const word of Object.values(PORT_STATUS)) {
      expect(/[0-9]/.test(word), word).toBe(false);
      expect(word.endsWith('.'), word).toBe(false);
      expect(word.includes(EM_DASH), word).toBe(false);
    }
  });
});
