// The Factory code a reader pastes in step 3 of Your first factory has to be the code the step 3
// board runs, so the board on the page shows what the reader's own board does. This test reads the
// page and the board file from disk and fails when the page's `Factory code` block differs from the
// board's Factory source. Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const PAGE = path.resolve(import.meta.dirname, '../../src/content/docs/get-started/first-factory.mdx');
const BOARD = path.resolve(import.meta.dirname, '../../../examples/boards/docs/start-first-factory-3.board.ron');

/** The fenced js block titled `Factory code`, with the list indent it sits under removed. */
function pageCode(mdx: string): string {
  const lines = mdx.split('\n');
  const starts = lines.flatMap((l, i) => (/^\s*```js title="Factory code"\s*$/.test(l) ? [i] : []));
  assert.equal(starts.length, 1, `${PAGE} has ${starts.length} Factory code blocks, expected 1`);
  const indent = /^(\s*)/.exec(lines[starts[0]])![1];
  const body: string[] = [];
  for (let i = starts[0] + 1; i < lines.length; i += 1) {
    if (/^\s*```\s*$/.test(lines[i])) return body.join('\n');
    body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
  }
  throw new Error(`the Factory code block in ${PAGE} never closes`);
}

/** The Factory source the board's Configure command sets, from `source: r#"` to `"#`. */
function boardCode(ron: string): string {
  const all = [...ron.matchAll(/Configure\(node:\s*\d+,\s*config:\s*Factory\(source:\s*r#"([\s\S]*?)"#\)\)/g)];
  assert.equal(all.length, 1, `${BOARD} has ${all.length} Factory Configure commands, expected 1`);
  return all[0][1];
}

const trimEnd = (s: string): string => s.replace(/\n+$/, '');

test('the Factory code on Your first factory equals the step 3 board (start-first-factory-3) Factory source', () => {
  const page = trimEnd(pageCode(fs.readFileSync(PAGE, 'utf8')));
  const board = trimEnd(boardCode(fs.readFileSync(BOARD, 'utf8')));
  assert.ok(board.length > 0, 'the step 3 board has Factory code');
  assert.equal(page, board, 'the page shows the code the step 3 board runs');
});
