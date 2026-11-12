// The board-name check a page's <Board name> goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  boardIdsOf,
  checkFaultsAbout,
  declaredFaultsOf,
  editDistance,
  faultLabelParts,
  faultReasonsOf,
  resolveBoard,
  suggest,
  type KnownBoard,
} from '../../src/lib/boards.ts';

const PAGE = 'site/src/content/docs/get-started/index.mdx';
const IDS = ['advanced', 'demo_scene', 'docs-arrival-order', 'docs-script-outcomes', 'order_processing'];
const KNOWN: KnownBoard[] = IDS.map((id) => ({ id, posterAlt: `${id}, a Fabrico board, at its last tick` }));

/** The message resolveBoard throws for this name, or a failed assertion when it returns. */
function thrown(name: string | undefined): string {
  try {
    const board = resolveBoard(name, PAGE, KNOWN);
    assert.fail(`resolveBoard(${JSON.stringify(name)}) returned ${board.id} instead of throwing`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof Error);
    return err.message;
  }
}

const NO_NAME = `[Board] ${PAGE} has a <Board> with no name. Give it a board id, for example <Board name="demo_scene" />.`;

const unknown = (name: string): string =>
  `[Board] ${PAGE} names board "${name}", and examples/boards/ has no board with that id. ` +
  `Known boards: ${IDS.join(', ')}. ` +
  'A board id is its path under examples/boards/ without .board.ron, with / turned into -.';

test('a known name returns that board', () => {
  assert.deepEqual(resolveBoard('demo_scene', PAGE, KNOWN), KNOWN[1]);
  assert.deepEqual(resolveBoard('docs-script-outcomes', PAGE, KNOWN), KNOWN[3]);
});

test('a missing name throws the no-name line with the page', () => {
  assert.equal(thrown(undefined), NO_NAME);
});

test('an empty name throws the no-name line with the page', () => {
  assert.equal(thrown(''), NO_NAME);
});

test('a name that starts an id throws, lists the five ids, and suggests that id', () => {
  assert.equal(thrown('demo'), `${unknown('demo')} Did you mean "demo_scene"?`);
});

test('names compare exactly: Demo_Scene is unknown and suggests demo_scene', () => {
  assert.equal(thrown('Demo_Scene'), `${unknown('Demo_Scene')} Did you mean "demo_scene"?`);
});

test('names compare exactly: demo-scene is unknown and suggests demo_scene', () => {
  assert.equal(thrown('demo-scene'), `${unknown('demo-scene')} Did you mean "demo_scene"?`);
});

test('a name far from every id throws with no suggestion', () => {
  assert.equal(thrown('zzzz'), unknown('zzzz'));
});

test('the id rule turns a nested board path into a dashed id, and skips other paths', () => {
  assert.deepEqual(
    boardIdsOf([
      'examples/boards/docs/script-outcomes.board.ron',
      'examples/boards/demo_scene.board.ron',
      'examples/boards/hashes.manifest',
      'docs/demo_scene.board.ron',
    ]),
    ['demo_scene', 'docs-script-outcomes'],
  );
});

test('the suggestion stops at 3 edits', () => {
  assert.equal(editDistance('advanced', 'advanced'), 0);
  assert.equal(editDistance('advnced', 'advanced'), 1);
  assert.equal(suggest('xxvanced', IDS), 'advanced');
  assert.equal(suggest('xxxanced', IDS), 'advanced');
  assert.equal(suggest('xxxxnced', IDS), null);
});

const REASONS = ['NoMatch', 'FactoryError', 'FactoryTimeout'];

/** The message faultReasonsOf throws for this prop, or a failed assertion when it returns. */
function faultThrown(prop: string): string {
  try {
    const names = faultReasonsOf(prop, PAGE, REASONS, 'demo_scene');
    assert.fail(`faultReasonsOf(${JSON.stringify(prop)}) returned ${names.join(' ')} instead of throwing`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof Error);
    return err.message;
  }
}

test('faultsAbout with two known reasons returns both, in the order written', () => {
  assert.deepEqual(faultReasonsOf('NoMatch FactoryError', PAGE, REASONS, 'demo_scene'), ['NoMatch', 'FactoryError']);
});

test('an empty or blank faultsAbout throws, naming the page, the board and the known reasons', () => {
  const blank = (prop: string): string =>
    `[Board] ${PAGE} gives board "demo_scene" the faultsAbout value "${prop}". ` +
    'Name each fault reason the board shows, separated by single spaces. Known reasons: NoMatch, FactoryError, FactoryTimeout.';
  assert.equal(faultThrown(''), blank(''));
  assert.equal(faultThrown('  '), blank('  '));
  assert.equal(faultThrown('NoMatch  FactoryError'), blank('NoMatch  FactoryError'));
});

test('a reason missing from facts.json throws the [Board] line with the known reasons', () => {
  assert.equal(
    faultThrown('NoMatch NotAReason'),
    `[Board] ${PAGE} says board "demo_scene" faults on purpose with "NotAReason", and ` +
      'site/src/generated/facts.json has no fault reason with that name. Known reasons: NoMatch, FactoryError, FactoryTimeout.',
  );
});

test('a reason given twice throws', () => {
  assert.equal(
    faultThrown('NoMatch NoMatch'),
    `[Board] ${PAGE} names "NoMatch" twice in the faultsAbout of board "demo_scene". Name each reason once.`,
  );
});

test('the fault line joins one name alone, two with and, three as A, B and C', () => {
  const line = (names: string[]): string => faultLabelParts(names).map((p) => p.name + p.after).join('');
  assert.equal(line(['A']), 'A');
  assert.equal(line(['A', 'B']), 'A and B');
  assert.equal(line(['A', 'B', 'C']), 'A, B and C');
  assert.deepEqual(faultLabelParts(['A', 'B']), [
    { name: 'A', after: ' and ' },
    { name: 'B', after: '' },
  ]);
});

const MANIFEST = [
  '# comment',
  'examples/boards/demo_scene.board.ron FactoryError',
  'examples/boards/docs/script-outcomes.board.ron CommandFailure CommandTimeout',
  '',
].join('\n');

/** The message checkFaultsAbout throws, or a failed assertion when it passes. */
function checkThrown(board: string, named: string[] | null): string {
  try {
    checkFaultsAbout(PAGE, board, named, declaredFaultsOf(MANIFEST));
  } catch (err) {
    assert.ok(err instanceof Error);
    return err.message;
  }
  return assert.fail(`checkFaultsAbout(${board}, ${JSON.stringify(named)}) passed instead of throwing`);
}

test('the faults manifest reads as board id to reasons, skipping comments and blank lines', () => {
  assert.deepEqual(
    [...declaredFaultsOf(MANIFEST)],
    [
      ['demo_scene', ['FactoryError']],
      ['docs-script-outcomes', ['CommandFailure', 'CommandTimeout']],
    ],
  );
});

test('a faults manifest line with no reason or no board path throws', () => {
  assert.throws(() => declaredFaultsOf('examples/boards/demo_scene.board.ron\n'), /line 1 isn't a board path and its fault reasons/);
  assert.throws(() => declaredFaultsOf('demo_scene FactoryError\n'), /line 1 isn't a board path/);
});

test('faultsAbout that names the board\'s reasons passes, in any order', () => {
  const declared = declaredFaultsOf(MANIFEST);
  checkFaultsAbout(PAGE, 'demo_scene', ['FactoryError'], declared);
  checkFaultsAbout(PAGE, 'docs-script-outcomes', ['CommandTimeout', 'CommandFailure'], declared);
  checkFaultsAbout(PAGE, 'advanced', null, declared);
});

test('faultsAbout naming another reason than the board raises throws with the value to write', () => {
  assert.equal(
    checkThrown('demo_scene', ['NoMatch']),
    `[Board] board "demo_scene" raises FactoryError (examples/boards/faults.manifest), and ${PAGE} gives it ` +
      'faultsAbout="NoMatch". Write faultsAbout="FactoryError" so the line under the board names the reasons it shows.',
  );
  assert.match(checkThrown('docs-script-outcomes', ['CommandFailure']), /Write faultsAbout="CommandFailure CommandTimeout"/);
});

test('a board that faults shown with no faultsAbout throws', () => {
  assert.match(checkThrown('demo_scene', null), /gives it no faultsAbout\. Write faultsAbout="FactoryError"/);
});

test('faultsAbout on a board that raises no fault throws', () => {
  assert.equal(
    checkThrown('advanced', ['NoMatch']),
    `[Board] ${PAGE} says board "advanced" faults on purpose with NoMatch, and examples/boards/faults.manifest records no ` +
      'fault for it. Drop faultsAbout, or make the board fault and add its line there.',
  );
});

test('the committed faults manifest parses, and names only fault reasons the facts know', () => {
  const site = path.resolve(import.meta.dirname, '../..');
  const declared = declaredFaultsOf(fs.readFileSync(path.join(site, '../examples/boards/faults.manifest'), 'utf8'));
  const facts = JSON.parse(fs.readFileSync(path.join(site, 'src/generated/facts.json'), 'utf8')) as { facts: Record<string, unknown> };
  assert.ok(declared.size >= 1, 'the manifest lists at least one board');
  for (const [board, reasons] of declared) {
    for (const reason of reasons) assert.ok(`fault.${reason}` in facts.facts, `${board}: ${reason} is no fault.* fact`);
  }
});
