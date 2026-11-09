// The board-name check a page's <Board name> goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardIdsOf, editDistance, resolveBoard, suggest, type KnownBoard } from '../../src/lib/boards.ts';

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
