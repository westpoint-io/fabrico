// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildCode, createCodeView, factoryLabels, highlight } from './codeView';

describe('highlight', () => {
  it('splits a line into keyword, string, comment and plain tokens that join back to the input', () => {
    const source = 'const a = "x"; // c';
    const tokens = highlight(source);
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    expect(tokens).toContainEqual({ kind: 'keyword', text: 'const' });
    expect(tokens).toContainEqual({ kind: 'string', text: '"x"' });
    expect(tokens).toContainEqual({ kind: 'comment', text: '// c' });
    expect(tokens.some((t) => t.kind === 'plain' && t.text.includes('a'))).toBe(true);
  });

  it('marks operators like keywords, and numbers, true, false, null and undefined as constants', () => {
    const tokens = highlight('x === 42 ? true : null; y = undefined || 0x1f || 1.5e3 || false;');
    const constants = tokens.filter((t) => t.kind === 'number').map((t) => t.text);
    expect(constants).toEqual(['42', 'true', 'null', 'undefined', '0x1f', '1.5e3', 'false']);
    const keywords = tokens.filter((t) => t.kind === 'keyword').map((t) => t.text);
    expect(keywords).toEqual(['===', '?', ':', '=', '||', '||', '||']);
  });

  it('keeps template literals, block comments and escaped quotes whole', () => {
    const source = 'let s = `a ${b} c`; /* one\ntwo */ const q = \'it\\\'s\';';
    const tokens = highlight(source);
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    expect(tokens).toContainEqual({ kind: 'string', text: '`a ${b} c`' });
    expect(tokens).toContainEqual({ kind: 'comment', text: '/* one\ntwo */' });
    expect(tokens).toContainEqual({ kind: 'string', text: "'it\\'s'" });
  });

  it('gives back an unterminated string or comment as written', () => {
    for (const source of ['"open', '/* open', '`open ${x}']) {
      expect(highlight(source).map((t) => t.text).join('')).toBe(source);
    }
  });
});

describe('buildCode', () => {
  it('turns markup in a source into text, creating only pre, span and text nodes', () => {
    const source = 'const html = "<img src=x onerror=alert(1)>";\n// <script>alert(2)</script>\n<b>bold</b>';
    const pre = buildCode(source);
    const kinds = new Set<string>();
    const walk = (node: Node): void => {
      kinds.add(node.nodeType === Node.TEXT_NODE ? '#text' : (node as Element).tagName);
      for (const child of node.childNodes) walk(child);
    };
    walk(pre);
    expect([...kinds].sort()).toEqual(['#text', 'PRE', 'SPAN']);
    expect(pre.querySelector('img, script, b')).toBeNull();
    expect(pre.textContent).toBe(source);
  });
});

describe('the code column', () => {
  it('labels Factories and Handlers in board order', () => {
    expect(
      factoryLabels([
        { renderHandle: 4, kind: 2, source: 'a' },
        { renderHandle: 9, kind: 10, source: 'b' },
        { renderHandle: 11, kind: 2, source: 'c' },
      ]),
    ).toEqual(['Factory 1', 'Handler 1', 'Factory 2']);
  });

  it('shows no tab row for one machine and one tab each for more, with arrow keys moving between them', () => {
    const one = createCodeView();
    one.setFactories([{ renderHandle: 1, kind: 2, source: 'one' }]);
    expect(one.root.hidden).toBe(false);
    expect(one.root.querySelector('[role="tablist"]')?.hasAttribute('hidden') ?? true).toBe(true);
    expect(one.text()).toBe('one');

    const two = createCodeView();
    document.body.append(two.root);
    two.setFactories([
      { renderHandle: 1, kind: 2, source: 'first' },
      { renderHandle: 2, kind: 10, source: 'second' },
    ]);
    const tabs = [...two.root.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(['Factory 1', 'Handler 1']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].classList.contains('is-pressed')).toBe(true);
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('aria-selected')).toBe('false');
    expect(two.text()).toBe('second');
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(two.text(), 'the arrow wraps round').toBe('first');
    two.root.remove();
  });

  it('hides itself for a board with no Factory', () => {
    const none = createCodeView();
    none.setFactories([]);
    expect(none.root.hidden).toBe(true);
  });
});
