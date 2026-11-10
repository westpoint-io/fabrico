// The fact lookup and formatting a page's <Fact id> goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFact, groupsText, keyGroups, resolveFact, type Fact, type FactsFile } from '../../src/lib/facts.ts';

const PAGE = 'site/src/content/docs/reference/index.mdx';

const FACTS: FactsFile = {
  facts: {
    'limit.ticks': { kind: 'quantity', value: 1200, unit: 'ticks', source: 'crates/x.rs', symbol: 'TICKS' },
    'fault.NoMatch': { kind: 'code', value: 'NoMatch', source: 'crates/fabrico-core/src/fault.rs' },
    'refusal.OutOfBounds': { kind: 'text', value: 'That cell is past the edge of the grid.', source: 'frontend/src/chrome/RefusalMessage.tsx' },
    'shortcut.save': { kind: 'shortcut', label: 'Ctrl+S', labelMac: 'Cmd+S', source: 'frontend/src/input/shortcuts.ts' },
    'shortcut.playPause': { kind: 'shortcut', label: 'Space', labelMac: 'Space', source: 'frontend/src/input/shortcuts.ts' },
    'shortcut.delete': { kind: 'shortcut', label: 'Delete or Backspace', labelMac: 'Delete or Backspace', source: 'frontend/src/input/shortcuts.ts' },
  },
};

const fact = (id: string): Fact => resolveFact(id, PAGE, FACTS);

const unknown = (id: string): string =>
  `[Fact] ${PAGE} asks for fact "${id}", and site/src/generated/facts.json has no fact with that id. ` +
  'Check the id against that file, or regenerate it with npm run facts from site/.';

/** The message resolveFact throws for this id, or a failed assertion when it returns. */
function thrown(id: string | undefined): string {
  try {
    const found = resolveFact(id, PAGE, FACTS);
    assert.fail(`resolveFact(${JSON.stringify(id)}) returned a ${found.kind} fact instead of throwing`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof Error);
    return err.message;
  }
}

test('a known id returns its fact', () => {
  assert.equal(fact('limit.ticks'), FACTS.facts['limit.ticks']);
  assert.equal(fact('shortcut.save'), FACTS.facts['shortcut.save']);
});

test('an unknown id throws the unknown-fact line naming the page and the id', () => {
  assert.equal(thrown('nope'), unknown('nope'));
});

test('a missing id throws the same line with an empty id', () => {
  assert.equal(thrown(undefined), unknown(''));
});

test('an id that is an Object property but not a fact still throws', () => {
  assert.equal(thrown('toString'), unknown('toString'));
  assert.equal(thrown('__proto__'), unknown('__proto__'));
});

test('a quantity renders with en-US separators and its unit', () => {
  assert.deepEqual(formatFact(fact('limit.ticks')), { kind: 'quantity', text: '1,200 ticks', bare: false });
});

test('a bare quantity renders the number alone', () => {
  assert.deepEqual(formatFact(fact('limit.ticks'), { bare: true }), { kind: 'quantity', text: '1,200', bare: true });
});

test('a code fact renders its value as code', () => {
  assert.deepEqual(formatFact(fact('fault.NoMatch')), { kind: 'code', text: 'NoMatch' });
});

test('a text fact renders its text as code', () => {
  assert.deepEqual(formatFact(fact('refusal.OutOfBounds')), { kind: 'code', text: 'That cell is past the edge of the grid.' });
});

test('a Ctrl shortcut renders Ctrl and S, with the macOS form Cmd+S', () => {
  const view = formatFact(fact('shortcut.save'));
  assert.deepEqual(view, { kind: 'shortcut', groups: [['Ctrl', 'S']], mac: [['Cmd', 'S']] });
  assert.ok(view.kind === 'shortcut' && view.mac !== null);
  assert.equal(groupsText(view.mac), 'Cmd+S');
});

test('play/pause renders the single key Space with no macOS form', () => {
  assert.deepEqual(formatFact(fact('shortcut.playPause')), { kind: 'shortcut', groups: [['Space']], mac: null });
});

test('a label with "or" renders two key groups with the word between them', () => {
  const view = formatFact(fact('shortcut.delete'));
  assert.deepEqual(view, { kind: 'shortcut', groups: [['Delete'], ['Backspace']], mac: null });
  assert.ok(view.kind === 'shortcut');
  assert.equal(groupsText(view.groups), 'Delete or Backspace');
});

test('key groups split on + inside a group and on " or " between groups', () => {
  assert.deepEqual(keyGroups('Ctrl+Shift+S'), [['Ctrl', 'Shift', 'S']]);
  assert.deepEqual(keyGroups('.'), [['.']]);
});
