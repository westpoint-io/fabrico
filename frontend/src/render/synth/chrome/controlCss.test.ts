// controlCss.test.ts - the control rules the app and a read-only board both read.
//
// The rules moved out of `chrome/chromeCss.ts` verbatim. These cases pin that the app's
// composed stylesheet did not change by one byte, and that each moved group lands in it
// exactly once (a group interpolated twice, or dropped, changes the hash anyway; the
// per-group count names which one).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as controlCss from './controlCss.ts';
import { CHROME_CSS } from '../../../chrome/chromeCss.ts';

/**
 * The sha256 of `CHROME_CSS` measured before the move, in this same test runner (so the
 * two font URLs resolve the same way). If the app's stylesheet is meant to change, this
 * literal moves in the same commit, with the reason.
 *
 * Moved once: the lesson ring's opacity pulse, its two keyframes and the reduced-motion rule
 * were added to `HINT_CSS`. The stylesheet differs from the one measured before the move by
 * those eleven lines and nothing else.
 *
 * Moved twice: the CSS comments in `controlCss.ts`'s strings became JS comments beside them,
 * so they no longer reach the board bundle. Only the comments, each with the one newline after
 * it, left the strings; every rule's text and order is the same. Checked by removing those
 * comments from the old `CHROME_CSS` and comparing it byte for byte with the new one.
 */
const CHROME_CSS_SHA256 = '03af01daac4f18b2f06e61aab275b9ef5503666e488dafea3649bb5b041d6f63';

const GROUPS = Object.entries(controlCss).filter(
  (e): e is [string, string] => typeof e[1] === 'string',
);

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) n++;
  return n;
}

describe('controlCss', () => {
  it('leaves the app stylesheet byte-for-byte as it was', () => {
    expect(createHash('sha256').update(CHROME_CSS, 'utf8').digest('hex')).toBe(CHROME_CSS_SHA256);
  });

  it('exports the groups a board needs, each holding its rules', () => {
    const names = GROUPS.map(([n]) => n).sort();
    expect(names).toEqual(['FIELD_CSS', 'HINT_CSS', 'PANEL_CSS', 'TOOL_BTN_CSS', 'VISUALLY_HIDDEN_CSS']);
    expect(controlCss.PANEL_CSS).toContain('.fab-title {');
    expect(controlCss.PANEL_CSS).toContain('background-color: var(--fab-panel-fill);');
    expect(controlCss.PANEL_CSS).toContain('box-shadow: var(--fab-bezel-ring-shadow);');
    expect(controlCss.HINT_CSS).toContain('.fab-hint {');
    expect(controlCss.TOOL_BTN_CSS).toContain('.fab-tool-btn:disabled');
    expect(controlCss.TOOL_BTN_CSS).toContain('header.fab-panel .fab-tool-btn');
    expect(controlCss.FIELD_CSS).toContain('.fab-field:focus-visible');
    expect(controlCss.VISUALLY_HIDDEN_CSS).toContain('.fab-visually-hidden {');
  });

  it('puts every exported group into the app stylesheet exactly once', () => {
    for (const [name, text] of GROUPS) {
      expect(text.length, `${name} is not empty`).toBeGreaterThan(0);
      expect(count(CHROME_CSS, text), `${name} appears once in CHROME_CSS`).toBe(1);
    }
  });

  it('carries no nearest-neighbour rendering hint', () => {
    // The chrome directory's own scan (`chrome/pixelatedRetirement.test.ts`) walks files
    // under `chrome/` and so no longer reads these rules. The same pattern, applied here.
    const HINT = /image-rendering\s*:\s*pixelated|imageRendering\s*:\s*'pixelated'/;
    for (const [name, text] of GROUPS) expect(HINT.test(text), `${name} has the hint`).toBe(false);
    expect(HINT.test('a { image-rendering: pixelated; }'), 'the pattern matches the hint').toBe(true);
  });
});
