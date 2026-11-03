// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { PlayerEffect } from '../player/playerWasm';
import { createEffectLog, effectRows, EMPTY_LINE, NO_CALLS_LINE } from './effectLog';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const URL = 'https://example.com/slow';

describe('effectRows', () => {
  it('an Http effect answered after 40 ticks reads t300, POST, its URL and ok, with tick 340 in the title', () => {
    const effects: PlayerEffect[] = [
      { tick: 300, effect: { kind: 'Http', url: URL, method: 'Post', body: bytes('{}') }, answer: { outcome: 'Reply', afterTicks: 40 } },
    ];
    expect(effectRows(effects)).toEqual([
      { kind: 'call', tick: 't300', method: 'POST', target: URL, outcome: 'ok', failed: false, title: `${URL}, answered at tick 340` },
    ]);
  });

  it('an Error reads error, a Timeout reads timeout, a Reply names its request, Debug is muted and Noop has no row', () => {
    const effects: PlayerEffect[] = [
      { tick: 150, effect: { kind: 'Http', url: 'https://example.com/bad', method: 'Get', body: bytes('') }, answer: { outcome: 'Error', afterTicks: 3 } },
      { tick: 200, effect: { kind: 'Http', url: 'https://example.com/lost', method: 'Delete', body: bytes('') }, answer: { outcome: 'Timeout' } },
      { tick: 251, effect: { kind: 'Reply', correlation: 7, payload: bytes('hello') }, answer: { outcome: 'Reply', afterTicks: 1 } },
      { tick: 260, effect: { kind: 'Noop' }, answer: { outcome: 'Reply', afterTicks: 1 } },
      { tick: 301, effect: { kind: 'Debug', message: bytes('{"order":"first"}') }, answer: { outcome: 'Reply', afterTicks: 1 } },
    ];
    const rows = effectRows(effects);
    expect(rows.map((r) => [r.tick, r.method, r.target, r.outcome])).toEqual([
      ['t150', 'GET', 'https://example.com/bad', 'error'],
      ['t200', 'DELETE', 'https://example.com/lost', 'timeout'],
      ['t251', 'REPLY', 'request 7', 'ok'],
      ['t301', 'DEBUG', '{"order":"first"}', ''],
    ]);
    expect(rows.map((r) => r.failed)).toEqual([true, true, false, false]);
    expect(rows[0].title).toBe('https://example.com/bad, answered at tick 153');
    expect(rows[1].title).toBe('https://example.com/lost, no answer, so it timed out');
    expect(rows[3].kind).toBe('debug');
    // No status code anywhere: the board format has none.
    for (const r of rows) {
      expect(['ok', 'error', 'timeout', '']).toContain(r.outcome);
      expect(`${r.method} ${r.outcome}`).not.toMatch(/\d/);
    }
  });
});

/** A log well with scroll metrics jsdom doesn't compute: rows are 20 px, the well 160 px. */
function measuredLog() {
  const log = createEffectLog();
  const well = log.well;
  let top = 0;
  Object.defineProperty(well, 'clientHeight', { get: () => 160 });
  Object.defineProperty(well, 'scrollHeight', { get: () => Math.max(160, well.querySelectorAll('.row').length * 20) });
  Object.defineProperty(well, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, well.scrollHeight - well.clientHeight));
    },
  });
  const scrollTo = (v: number): void => {
    well.scrollTop = v;
    well.dispatchEvent(new Event('scroll'));
  };
  return { log, well, scrollTo, top: () => top };
}

const debugAt = (tick: number): PlayerEffect => ({ tick, effect: { kind: 'Debug', message: bytes(`m${tick}`) }, answer: { outcome: 'Reply', afterTicks: 1 } });

describe('the log well', () => {
  it('follows the newest row unless the reader has scrolled up, and stays where the reader left it', () => {
    const { log, scrollTo, top } = measuredLog();
    log.setCallsOut(true);
    log.append(effectRows(Array.from({ length: 20 }, (_, i) => debugAt(100 + i))));
    expect(top(), 'it follows the newest row').toBe(20 * 20 - 160);
    scrollTo(40);
    log.append(effectRows([debugAt(200)]));
    expect(top(), 'scrolled up, it stays put').toBe(40);
    scrollTo(21 * 20 - 160);
    log.append(effectRows([debugAt(201)]));
    expect(top(), 'back at the bottom, it follows again').toBe(22 * 20 - 160);
  });

  it('shows the empty line chosen by calls_out until a call arrives, and Restart clears it', () => {
    const { log, well } = measuredLog();
    log.setCallsOut(true);
    expect(well.textContent).toBe(EMPTY_LINE);
    log.append(effectRows([debugAt(5)]));
    expect(well.querySelector('.note')?.textContent, 'a Debug row is not a call').toBe(EMPTY_LINE);
    log.append(effectRows([{ tick: 9, effect: { kind: 'Http', url: URL, method: 'Post', body: bytes('') }, answer: { outcome: 'Timeout' } }]));
    expect(well.querySelector('.note')).toBeNull();
    expect(log.rows()).toHaveLength(2);
    log.clear();
    expect(log.rows()).toHaveLength(0);
    expect(well.textContent).toBe(EMPTY_LINE);

    const quiet = measuredLog();
    quiet.log.setCallsOut(false);
    expect(quiet.well.textContent).toBe(NO_CALLS_LINE);
  });

  it('puts board text in cells as text', () => {
    const { log, well } = measuredLog();
    log.append(effectRows([{ tick: 1, effect: { kind: 'Debug', message: bytes('<img src=x onerror=alert(1)>') }, answer: { outcome: 'Timeout' } }]));
    expect(well.querySelector('img')).toBeNull();
    expect(log.rows()[0].target).toBe('<img src=x onerror=alert(1)>');
  });
});
