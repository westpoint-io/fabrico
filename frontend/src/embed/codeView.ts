// The read-only code view beside a board: the JavaScript each Factory and HTTP Handler runs, as
// text. The source comes from a board file anyone can edit, and a docs page shows it, so it never
// passes through an HTML parser: `highlight` splits it into tokens and `buildCode` makes one `pre`
// of `span` elements whose words go in with `textContent`.
//
// The colours follow the app's Factory editor: keywords and operators in the focus blue, strings
// and template literals in the working green, numbers and `true`, `false`, `null`, `undefined` in
// the item amber, comments in the lit edge tone, and everything else in ink.
//
// Tabs read `Factory 1`, `Factory 2` in board order and `Handler 1` for an HTTP Handler. A Factory
// has no label of its own (a Label is a separate machine), so the order is the only name it has.
// With one machine there's no tab row; with none the column hides.

import type { BoardFactory } from '../player/playerWasm';

/** A token's colour class. Operators share the keyword colour, so they share its kind. */
export type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);
const CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const OPERATOR = /^(?:>>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|\*\*|<<|>>|[=+\-*/%<>!&|^~?:])/;
const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/;
const IDENT = /^[A-Za-z_$][\w$]*/;

/** Where a quoted string that opens at `start` ends (exclusive), honouring backslash escapes. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    // A plain quoted string ends at a line break even when it isn't closed.
    if (quote !== '`' && c === '\n') return i;
    i += 1;
  }
  return source.length;
}

/** Split JavaScript into coloured tokens. Joining the tokens' text gives the source back. */
export function highlight(source: string): Token[] {
  const out: Token[] = [];
  const push = (kind: TokenKind, text: string): void => {
    if (text === '') return;
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === kind && kind === 'plain') last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const c = source[i];
    if (rest.startsWith('//')) {
      const nl = source.indexOf('\n', i);
      const end = nl < 0 ? source.length : nl;
      push('comment', source.slice(i, end));
      i = end;
    } else if (rest.startsWith('/*')) {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : close + 2;
      push('comment', source.slice(i, end));
      i = end;
    } else if (c === '"' || c === "'" || c === '`') {
      const end = stringEnd(source, i);
      push('string', source.slice(i, end));
      i = end;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const m = NUMBER.exec(rest);
      const text = m === null ? c : m[0];
      push('number', text);
      i += text.length;
    } else if (/[A-Za-z_$]/.test(c)) {
      const word = (IDENT.exec(rest) as RegExpExecArray)[0];
      push(KEYWORDS.has(word) ? 'keyword' : CONSTANTS.has(word) ? 'number' : 'plain', word);
      i += word.length;
    } else {
      const op = OPERATOR.exec(rest);
      if (op !== null) {
        push('keyword', op[0]);
        i += op[0].length;
      } else {
        push('plain', c);
        i += 1;
      }
    }
  }
  return out;
}

/** One `pre` of `span` elements for a source. Text only: nothing in it is parsed as HTML. */
export function buildCode(source: string): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.className = 'code';
  for (const token of highlight(source)) {
    const span = document.createElement('span');
    span.className = `tok-${token.kind}`;
    span.textContent = token.text;
    pre.append(span);
  }
  return pre;
}

/** The machine kind byte of an HTTP Handler. A Factory is 2. */
const HANDLER_KIND = 10;

/** `Factory 1`, `Factory 2` and `Handler 1`, in board order. */
export function factoryLabels(factories: readonly BoardFactory[]): string[] {
  let factory = 0;
  let handler = 0;
  return factories.map((f) => (f.kind === HANDLER_KIND ? `Handler ${++handler}` : `Factory ${++factory}`));
}

export interface CodeView {
  root: HTMLDivElement;
  /** The board's Factories and Handlers. An empty list hides the column. */
  setFactories(factories: readonly BoardFactory[]): void;
  /** The tab labels shown, in order; empty when there's no tab row. */
  labels(): string[];
  /** The source the well shows. */
  text(): string;
  /** The well that scrolls the code. */
  well(): HTMLDivElement;
}

export function createCodeView(): CodeView {
  const root = document.createElement('div');
  root.className = 'code-column';
  root.hidden = true;
  const inner = document.createElement('div');
  inner.className = 'code-inner';
  const heading = document.createElement('p');
  heading.className = 'panel-heading';
  heading.textContent = 'FACTORY CODE';
  const tablist = document.createElement('div');
  tablist.className = 'code-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Factory code');
  tablist.hidden = true;
  const well = document.createElement('div');
  well.className = 'code-well';
  well.tabIndex = 0;
  well.setAttribute('role', 'tabpanel');
  well.setAttribute('aria-label', 'Factory code');
  inner.append(heading, tablist, well);
  root.append(inner);

  let factories: readonly BoardFactory[] = [];
  let tabs: HTMLButtonElement[] = [];

  const select = (index: number, focus: boolean): void => {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.classList.toggle('is-pressed', on);
      tab.tabIndex = on ? 0 : -1;
    });
    const source = factories[index]?.source ?? '';
    well.replaceChildren(buildCode(source));
    if (tabs[index] !== undefined) well.setAttribute('aria-labelledby', tabs[index].id);
    if (focus) tabs[index]?.focus();
  };

  return {
    root,
    setFactories(next): void {
      factories = [...next];
      root.hidden = factories.length === 0;
      const labels = factoryLabels(factories);
      tabs = factories.length < 2 ? [] : labels.map((label, i) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'fab-tool-btn code-tab';
        tab.setAttribute('role', 'tab');
        tab.id = `code-tab-${i}`;
        tab.textContent = label;
        tab.addEventListener('click', () => select(i, false));
        tab.addEventListener('keydown', (event) => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (step === 0) return;
          event.preventDefault();
          select((i + step + tabs.length) % tabs.length, true);
        });
        return tab;
      });
      tablist.replaceChildren(...tabs);
      tablist.hidden = tabs.length === 0;
      if (tabs.length === 0) well.removeAttribute('aria-labelledby');
      select(0, false);
    },
    labels: () => tabs.map((t) => t.textContent ?? ''),
    text: () => well.textContent ?? '',
    well: () => well,
  };
}
