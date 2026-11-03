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
 */
const CHROME_CSS_SHA256 = '1c61fb43f6f2807deea2f3cf68dd47ab5ba89c862bfcd7b6765a438a480263c6';

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
});
