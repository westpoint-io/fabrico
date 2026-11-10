// The freshness comparison CI runs after `npm run facts`:
//   git diff --exit-code -- site/src/generated/facts.json
// This proves the comparison itself bites, in a throwaway git repo: the committed facts.json with
// one value changed makes it exit non-zero, and the file left as committed makes it exit 0.
// Run with `npm run test:unit` in site/.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const FACTS = path.resolve(import.meta.dirname, '../../src/generated/facts.json');
const REL = 'site/src/generated/facts.json';

let repo = '';

function git(...args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  return { status: result.status, stdout: result.stdout };
}

function mustGit(...args: string[]): void {
  const { status } = git(...args);
  assert.equal(status, 0, `git ${args.join(' ')} exited ${status}`);
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-fresh-'));
  fs.mkdirSync(path.join(repo, path.dirname(REL)), { recursive: true });
  fs.copyFileSync(FACTS, path.join(repo, REL));
  mustGit('init', '-q');
  mustGit('add', REL);
  mustGit('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'facts');
});

after(() => {
  if (repo !== '') fs.rmSync(repo, { recursive: true, force: true });
});

test('an unchanged facts.json passes the comparison', () => {
  assert.equal(git('diff', '--exit-code', '--', REL).status, 0);
});

test('facts.json with one value changed fails the comparison and shows the line', () => {
  const file = path.join(repo, REL);
  const committed = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(committed) as { facts: Record<string, { value?: unknown }> };
  const rate = data.facts['embed.ticks_per_second'];
  assert.equal(typeof rate?.value, 'number', 'facts.json has a numeric embed.ticks_per_second');
  rate.value = (rate.value as number) + 1;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  try {
    const { status, stdout } = git('diff', '--exit-code', '--', REL);
    assert.notEqual(status, 0);
    assert.match(stdout, new RegExp(`^\\+\\s+"value": ${(rate.value as number).toString()},?$`, 'm'));
  } finally {
    fs.writeFileSync(file, committed);
  }
  assert.equal(git('diff', '--exit-code', '--', REL).status, 0, 'the restored file passes again');
});
