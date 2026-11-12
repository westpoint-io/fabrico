// The anchor ids and the prop check a troubleshooting page's <Fix> goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyFixMessage, fixAnchor, fixTarget, isEmptyFixText, symptomAnchor, type FactsFile } from '../../src/lib/facts.ts';

const PAGE = 'site/src/content/docs/troubleshooting/refusals.mdx';

const FACTS: FactsFile = {
  facts: {
    'refusal.BeltTooLong': { kind: 'text', value: 'That belt is too long. Draw it in shorter runs.', source: 'frontend/src/chrome/RefusalMessage.tsx' },
    'fault.NoMatch': { kind: 'code', value: 'NoMatch', source: 'crates/fabrico-core/src/fault.rs' },
    'limit.max_belt_tiles': { kind: 'quantity', value: 1024, unit: 'tiles', source: 'crates/fabrico-core/src/edit.rs' },
  },
};

/** The message fixTarget throws for these props, or a failed assertion when it returns. */
function thrown(props: { id?: string; symptom?: string }): string {
  try {
    const found = fixTarget(props, PAGE, FACTS);
    assert.fail(`fixTarget(${JSON.stringify(props)}) returned a ${found.kind} entry instead of throwing`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof Error);
    return err.message;
  }
}

const prefixLine = (id: string): string =>
  `[Fix] ${PAGE} gives <Fix> the id "${id}". A fix entry takes a fault.* or refusal.* fact id, ` +
  'or symptom="..." for a hand-written entry.';

test('a fact id becomes its prefix and the kebab-case name', () => {
  assert.equal(fixAnchor('refusal.BeltTooLong'), 'refusal-belt-too-long');
  assert.equal(fixAnchor('fault.NoEntryWire'), 'fault-no-entry-wire');
  assert.equal(fixAnchor('fault.NoMatch'), 'fault-no-match');
});

test('a capital after a digit gets a hyphen, capitals in a row get none, one word stays one word', () => {
  assert.equal(fixAnchor('refusal.Step2Fails'), 'refusal-step2-fails');
  assert.equal(fixAnchor('refusal.HTTPError'), 'refusal-httperror');
  assert.equal(fixAnchor('refusal.Malformed'), 'refusal-malformed');
});

test('a symptom becomes symptom- and its words joined by single hyphens, trimmed at the ends', () => {
  assert.equal(symptomAnchor('Items stop at the end of a belt'), 'symptom-items-stop-at-the-end-of-a-belt');
  assert.equal(symptomAnchor('  A -- b  '), 'symptom-a-b');
  assert.equal(symptomAnchor('A webhook call gets "connection refused"'), 'symptom-a-webhook-call-gets-connection-refused');
});

test('a known fact id returns a fact entry with its anchor', () => {
  assert.deepEqual(fixTarget({ id: 'refusal.BeltTooLong' }, PAGE, FACTS), {
    kind: 'fact',
    id: 'refusal.BeltTooLong',
    anchor: 'refusal-belt-too-long',
  });
  assert.deepEqual(fixTarget({ id: 'fault.NoMatch' }, PAGE, FACTS), { kind: 'fact', id: 'fault.NoMatch', anchor: 'fault-no-match' });
});

test('a symptom returns a symptom entry with its text trimmed and its anchor', () => {
  assert.deepEqual(fixTarget({ symptom: ' Items stop at the end of a belt ' }, PAGE, FACTS), {
    kind: 'symptom',
    text: 'Items stop at the end of a belt',
    anchor: 'symptom-items-stop-at-the-end-of-a-belt',
  });
});

test('both id and symptom, or neither, throws the both-or-neither line', () => {
  assert.equal(
    thrown({ id: 'refusal.BeltTooLong', symptom: 'Items stop' }),
    `[Fix] ${PAGE} has a <Fix> with both id and symptom. Give it one of them.`,
  );
  assert.equal(thrown({}), `[Fix] ${PAGE} has a <Fix> with neither id nor symptom. Give it one of them.`);
  assert.equal(thrown({ symptom: '   ' }), `[Fix] ${PAGE} has a <Fix> with neither id nor symptom. Give it one of them.`);
});

test('an id outside fault.* and refusal.* throws the prefix line, even when facts.json has it', () => {
  assert.equal(thrown({ id: 'limit.max_belt_tiles' }), prefixLine('limit.max_belt_tiles'));
  assert.equal(thrown({ id: 'refusal.' }), prefixLine('refusal.'));
  assert.equal(thrown({ id: '' }), prefixLine(''));
});

test('an unknown fault or refusal id throws the [Fact] line', () => {
  assert.equal(
    thrown({ id: 'refusal.NotATag' }),
    `[Fact] ${PAGE} asks for fact "refusal.NotATag", and site/src/generated/facts.json has no fact with that id. ` +
      'Check the id against that file, or regenerate it with npm run facts from site/.',
  );
});

test('fix text with only tags and white space counts as empty', () => {
  assert.equal(isEmptyFixText(''), true);
  assert.equal(isEmptyFixText('  \n '), true);
  assert.equal(isEmptyFixText('<p> </p>\n'), true);
  assert.equal(isEmptyFixText('<p>Draw it in two parts.</p>'), false);
});

test('the empty-fix line names the page and the entry', () => {
  assert.equal(
    emptyFixMessage(PAGE, 'refusal.BeltTooLong'),
    `[Fix] ${PAGE} has a <Fix> for "refusal.BeltTooLong" with no fix text. ` +
      'Write what causes it and how to fix it between <Fix> and </Fix>.',
  );
});
