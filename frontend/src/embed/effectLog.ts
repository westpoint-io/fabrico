// The effect log under a board: each outbound call the run would make, from the player's own
// effect records (`decodePlayerEffects`). Nothing is sent. The player records each call and the
// board file's executor scripts its answer, so a row says what the engine acted on: `ok`, `error`
// or `timeout`. The board format has no HTTP status code for an outbound call, so a call row never
// prints one; a printed code could disagree with the path the engine took.
//
// Row shapes, in a four-column grid (tick, method, target, outcome):
//   Http   `t300  POST    https://example.com/slow  ok`, title `<url>, answered at tick 340`
//          or `<url>, no answer, so it timed out`
//   Route  `t40   ROUTE   request 0: POST /endpoint/hello`, a request the script sent in through a
//          Route, with no outcome; title `Request 0 reached the Route: POST /endpoint/hello`
//   Reply  `t41   REPLY   request 0: status 200     ok`, the status the Handler's reply carries,
//          read from its JSON; `request 0` alone when the payload has no numeric status. The
//          number is the request's correlation id, so a ROUTE row and its REPLY row share it.
//   Fault  `t689  FAULT   CommandTimeout`, or `FAULT  NoMatch: <first line of the payload>`, with
//          no outcome; title `<Reason> fault, keeps no payload` or `<Reason> fault, payload:
//          <whole payload>`. The player decides which Debug messages are faults, by the engine's
//          fault-path rule, so this file never sniffs bytes.
//   Debug  `t301  DEBUG   <message>`, a muted row with no outcome
//   Noop   no row
//
// ROUTE and REPLY rows stay in ink whatever the status.
//
// The well follows the newest row unless the reader has scrolled up, and then stays where the
// reader left it. Restart clears it. On a board that calls out, `EMPTY_LINE` shows only while the
// well holds no row, so the first row of any kind removes it; a board with no outbound machine
// keeps `NO_CALLS_LINE` above its DEBUG and FAULT rows, since that stays true. Every word goes in
// with `textContent`.

import { decodePlayerEffects, type PlayerEffect } from '../player/playerWasm';

/** The empty line on a board that calls out, while the well holds no row. */
export const EMPTY_LINE = 'No outbound calls yet. Each call this board makes shows up here with its tick and its scripted result.';
/** The line on a board with no outbound machine. */
export const NO_CALLS_LINE = 'This board makes no outbound calls.';
/** How close to the bottom, in CSS px, still counts as following the newest row. */
const FOLLOW_SLACK_PX = 2;

export interface EffectRow {
  /** `call` for Http, `request` for Request, `reply` for Reply, `fault` for Fault, `debug` for Debug. */
  kind: 'call' | 'request' | 'reply' | 'fault' | 'debug';
  /** `t300`. */
  tick: string;
  /** `POST`, `ROUTE`, `REPLY`, `FAULT` or `DEBUG`. */
  method: string;
  /**
   * The URL, `request <n>: <METHOD> <path>`, `request <n>` with `: status <code>` when the reply
   * has one, the fault reason and its payload's first line, or the Debug message.
   */
  target: string;
  /** `ok`, `error` or `timeout`; empty on a Route, Fault or Debug row. */
  outcome: string;
  /** Whether the outcome is a failure, shown in the destructive colour. */
  failed: boolean;
  /** The row's title: the full target and when it was answered. */
  title: string;
}

const MESSAGE = new TextDecoder('utf-8', { fatal: false });

/**
 * The status a Handler's reply carries: its payload is the JSON object the Handler passed to
 * `ctx.command`, so a whole-number `status` there is the status the caller gets. Anything else,
 * including bytes that aren't JSON, gives null and the row keeps `request <n>` alone.
 */
function replyStatus(payload: Uint8Array): number | null {
  let value: unknown;
  try {
    value = JSON.parse(MESSAGE.decode(payload));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const status: unknown = (value as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/** The rows for a batch of effects, in order. Noop has none. */
export function effectRows(effects: readonly PlayerEffect[]): EffectRow[] {
  const rows: EffectRow[] = [];
  for (const { tick, effect, answer } of effects) {
    const t = `t${tick}`;
    const outcome = answer.outcome === 'Reply' ? 'ok' : answer.outcome === 'Error' ? 'error' : answer.outcome === 'Timeout' ? 'timeout' : '';
    const when =
      answer.outcome === 'Reply' || answer.outcome === 'Error'
        ? `answered at tick ${tick + answer.afterTicks}`
        : 'no answer, so it timed out';
    switch (effect.kind) {
      case 'Http':
        rows.push({
          kind: 'call',
          tick: t,
          method: effect.method.toUpperCase(),
          target: effect.url,
          outcome,
          failed: outcome !== 'ok',
          title: `${effect.url}, ${when}`,
        });
        break;
      case 'Request': {
        const asked = `${effect.method} ${effect.path}`;
        rows.push({
          kind: 'request',
          tick: t,
          method: 'ROUTE',
          target: `request ${effect.correlation}: ${asked}`,
          outcome: '',
          failed: false,
          title: `Request ${effect.correlation} reached the Route: ${asked}`,
        });
        break;
      }
      case 'Reply': {
        const status = replyStatus(effect.payload);
        const target = `request ${effect.correlation}${status === null ? '' : `: status ${status}`}`;
        rows.push({ kind: 'reply', tick: t, method: 'REPLY', target, outcome, failed: outcome !== 'ok', title: `Reply to ${target}, ${when}` });
        break;
      }
      case 'Fault': {
        const payload = MESSAGE.decode(effect.payload);
        const firstLine = payload.split(/\r?\n/, 1)[0];
        const target = payload === '' ? effect.reason : `${effect.reason}: ${firstLine}`;
        const title = payload === '' ? `${effect.reason} fault, keeps no payload` : `${effect.reason} fault, payload: ${payload}`;
        rows.push({ kind: 'fault', tick: t, method: 'FAULT', target, outcome: '', failed: false, title });
        break;
      }
      case 'Debug': {
        const message = MESSAGE.decode(effect.message);
        rows.push({ kind: 'debug', tick: t, method: 'DEBUG', target: message, outcome: '', failed: false, title: message });
        break;
      }
      case 'Noop':
        break;
    }
  }
  return rows;
}

/** Decode the bytes `takeEffects` returns into rows. */
export function rowsFromBytes(bytes: Uint8Array): EffectRow[] {
  return effectRows(decodePlayerEffects(bytes));
}

export interface EffectLog {
  root: HTMLDivElement;
  /** The scrolling well, `role="log"`. */
  well: HTMLDivElement;
  /** Whether the board has an outbound machine; picks the empty line. */
  setCallsOut(callsOut: boolean): void;
  append(rows: readonly EffectRow[]): void;
  clear(): void;
  /** Every row shown, in order. */
  rows(): EffectRow[];
}

function cell(className: string, text: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

export function createEffectLog(): EffectLog {
  const root = document.createElement('div');
  root.className = 'effect-log';
  const head = document.createElement('div');
  head.className = 'log-head';
  const heading = document.createElement('p');
  heading.className = 'panel-heading';
  heading.textContent = 'EFFECT LOG';
  const aside = document.createElement('p');
  aside.className = 'log-aside';
  aside.textContent = 'scripted, nothing is sent';
  head.append(heading, aside);
  const well = document.createElement('div');
  well.className = 'log-well';
  well.setAttribute('role', 'log');
  well.setAttribute('aria-label', 'Effect log');
  well.tabIndex = 0;
  root.append(head, well);

  let callsOut: boolean | null = null;
  let shown: EffectRow[] = [];
  let note: HTMLParagraphElement | null = null;
  let follow = true;

  well.addEventListener('scroll', () => {
    follow = well.scrollHeight - well.scrollTop - well.clientHeight <= FOLLOW_SLACK_PX;
  });

  /** The empty line shows until the first row of any kind, and always on a board that calls nothing. */
  const syncNote = (): void => {
    const text = callsOut === null ? null : callsOut ? (shown.length === 0 ? EMPTY_LINE : null) : NO_CALLS_LINE;
    if (text === null) {
      note?.remove();
      note = null;
      return;
    }
    if (note === null) {
      note = document.createElement('p');
      note.className = 'note';
      well.prepend(note);
    }
    if (note.textContent !== text) note.textContent = text;
  };

  return {
    root,
    well,
    setCallsOut(next): void {
      callsOut = next;
      syncNote();
    },
    append(rows): void {
      if (rows.length === 0) return;
      for (const r of rows) {
        const row = document.createElement('div');
        row.className = `row is-${r.kind}`;
        row.title = r.title;
        const outcome = cell('outcome', r.outcome);
        if (r.failed) outcome.classList.add('is-failure');
        row.append(cell('tick', r.tick), cell('method', r.method), cell('target', r.target), outcome);
        well.append(row);
      }
      shown = shown.concat(rows);
      syncNote();
      if (follow) well.scrollTop = well.scrollHeight;
    },
    clear(): void {
      shown = [];
      well.replaceChildren();
      note = null;
      follow = true;
      well.scrollTop = 0;
      syncNote();
    },
    rows: () => shown.map((r) => ({ ...r })),
  };
}
