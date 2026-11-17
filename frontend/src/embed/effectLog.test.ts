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

describe('FAULT rows', () => {
  const faultAt = (tick: number, reason: string, payload: string): PlayerEffect => ({
    tick,
    effect: { kind: 'Fault', reason, payload: bytes(payload) },
    answer: { outcome: 'Reply', afterTicks: 1 },
  });

  it('a FAULT row with an empty payload shows the reason alone and says it keeps no payload', () => {
    expect(effectRows([faultAt(689, 'CommandTimeout', '')])).toEqual([
      { kind: 'fault', tick: 't689', method: 'FAULT', target: 'CommandTimeout', outcome: '', failed: false, title: 'CommandTimeout fault, keeps no payload' },
    ]);
  });

  it('a FAULT row with a two-line payload shows the first line in its target and both lines in its title', () => {
    const payload = "Error: unexpected token: 'order'\n    at <eval> (factory.js:3)";
    const [row] = effectRows([faultAt(154, 'FactoryError', payload)]);
    expect([row.tick, row.method, row.target, row.outcome]).toEqual(['t154', 'FAULT', "FactoryError: Error: unexpected token: 'order'", '']);
    expect(row.title).toBe(`FactoryError fault, payload: ${payload}`);
    expect(row.kind).toBe('fault');
  });

  it('a FAULT row lands in the well with the is-fault class and no outcome', () => {
    const log = createEffectLog();
    log.append(effectRows([faultAt(689, 'CommandTimeout', '')]));
    const row = log.well.querySelector('.row') as HTMLElement;
    expect(row.className).toBe('row is-fault');
    expect([...row.children].map((c) => c.textContent)).toEqual(['t689', 'FAULT', 'CommandTimeout', '']);
    expect(row.title).toBe('CommandTimeout fault, keeps no payload');
  });
});

describe('ROUTE and REPLY rows', () => {
  const requestAt = (tick: number, correlation: number, method: string, path: string): PlayerEffect => ({
    tick,
    effect: { kind: 'Request', correlation, method, path },
    answer: { outcome: 'Inbound' },
  });
  const replyAt = (tick: number, correlation: number, payload: string): PlayerEffect => ({
    tick,
    effect: { kind: 'Reply', correlation, payload: bytes(payload) },
    answer: { outcome: 'Reply', afterTicks: 1 },
  });

  it('a Request gives one ROUTE row, request 0: POST /endpoint/hello, with no outcome and the Inbound answer ignored', () => {
    expect(effectRows([requestAt(40, 0, 'POST', '/endpoint/hello')])).toEqual([
      {
        kind: 'request',
        tick: 't40',
        method: 'ROUTE',
        target: 'request 0: POST /endpoint/hello',
        outcome: '',
        failed: false,
        title: 'Request 0 reached the Route: POST /endpoint/hello',
      },
    ]);
  });

  it('a Reply whose payload holds a numeric status shows request 3: status 201, and the status in its title', () => {
    const [row] = effectRows([replyAt(41, 3, '{"status":201,"headers":{},"body":"x"}')]);
    expect([row.kind, row.tick, row.method, row.target, row.outcome]).toEqual(['reply', 't41', 'REPLY', 'request 3: status 201', 'ok']);
    expect(row.title).toBe('Reply to request 3: status 201, answered at tick 42');
  });

  it('a Reply whose payload is not JSON, or is JSON with no numeric status, keeps request 3 and the title with no status', () => {
    for (const payload of ['hello', '', '{"status":"201"}', '{"code":201}', '[201]', 'null', '201', '{"status":201']) {
      const [row] = effectRows([replyAt(41, 3, payload)]);
      expect(row.target, payload).toBe('request 3');
      expect(row.title, payload).toBe('Reply to request 3, answered at tick 42');
    }
  });

  it('ROUTE and REPLY rows stay in ink whatever status the Handler chose', () => {
    const rows = effectRows([requestAt(120, 1, 'POST', '/endpoint/hello'), replyAt(121, 1, '{"status":500}')]);
    expect(rows.map((r) => [r.method, r.target, r.failed])).toEqual([
      ['ROUTE', 'request 1: POST /endpoint/hello', false],
      ['REPLY', 'request 1: status 500', false],
    ]);
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

  it('shows the empty line on a board that calls out until the first row of any kind, and Restart brings it back', () => {
    const { log, well } = measuredLog();
    log.setCallsOut(true);
    expect(well.textContent).toBe(EMPTY_LINE);
    log.append(effectRows([debugAt(5)]));
    expect(well.querySelector('.note'), 'a DEBUG row removes the empty line too').toBeNull();
    log.append(effectRows([{ tick: 9, effect: { kind: 'Http', url: URL, method: 'Post', body: bytes('') }, answer: { outcome: 'Timeout' } }]));
    expect(well.querySelector('.note')).toBeNull();
    expect(log.rows()).toHaveLength(2);
    log.clear();
    expect(log.rows()).toHaveLength(0);
    expect(well.textContent).toBe(EMPTY_LINE);
  });

  it('keeps the no-calls line above DEBUG and FAULT rows on a board with no outbound machine', () => {
    const { log, well } = measuredLog();
    log.setCallsOut(false);
    expect(well.textContent).toBe(NO_CALLS_LINE);
    log.append(effectRows([debugAt(5), { tick: 7, effect: { kind: 'Fault', reason: 'NoMatch', payload: bytes('{}') }, answer: { outcome: 'Reply', afterTicks: 1 } }]));
    expect(well.firstElementChild?.className).toBe('note');
    expect(well.querySelector('.note')?.textContent).toBe(NO_CALLS_LINE);
    expect(log.rows().map((r) => r.method)).toEqual(['DEBUG', 'FAULT']);
  });

  it('puts board text in cells as text', () => {
    const { log, well } = measuredLog();
    log.append(effectRows([{ tick: 1, effect: { kind: 'Debug', message: bytes('<img src=x onerror=alert(1)>') }, answer: { outcome: 'Timeout' } }]));
    expect(well.querySelector('img')).toBeNull();
    expect(log.rows()[0].target).toBe('<img src=x onerror=alert(1)>');
  });
});
