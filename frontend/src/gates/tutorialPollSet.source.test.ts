// THE CONFIG POLL ASKS ABOUT THE SET THE UNIT FRAMES ANSWER FOR (plan 104-09, WR-04).
//
// `boundMachineHandles` in `src/tutorial/check.ts` decides which machines get config answers.
// `machine.test.ts` builds its frames' answers from it, so those tests only say something about the app
// while TutorialLayer's poll asks the host about the same set. This reads TutorialLayer.tsx as source
// and checks the chain: the import, `boundMachineIds` returning that function's result over the state's
// bindings, the poll effect's ids coming from `boundMachineIds(state)`, `readAppliedConfig` only being
// called for those ids, and the frame's answers filtered by `boundMachineIds` too.
//
// NOT SEEN: a poll that calls the right function and then adds or drops ids at runtime by some route
// these patterns don't name. The mutation cases below are what stop this being a check that can't fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from './walkSpecSource';

const LAYER = fileURLToPath(new URL('../chrome/tutorial/TutorialLayer.tsx', import.meta.url));

/** Every way the layer's poll set can stop being `boundMachineHandles`; empty means the wiring holds. */
export function pollSetBreaches(raw: string): string[] {
  const src = stripComments(raw);
  const out: string[] = [];

  if (!/import\s*\{[^}]*\bboundMachineHandles\b[^}]*\}\s*from\s*'\.\.\/\.\.\/tutorial\/check(\.ts)?'/.test(src)) {
    out.push('TutorialLayer does not import boundMachineHandles from ../../tutorial/check');
  }

  const body = /function\s+boundMachineIds\s*\(\s*s\s*:\s*TutorialState\s*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/.exec(src)?.[1];
  if (body === undefined) {
    out.push('boundMachineIds(s: TutorialState): string is gone');
  } else if (!/^\s*return\s+s\.card\s*===\s*'running'\s*\?\s*boundMachineHandles\(\s*s\.bindings\s*\)\.join\(\s*','\s*\)\s*:\s*''\s*;\s*$/.test(body)) {
    out.push('boundMachineIds does not return boundMachineHandles(s.bindings).join(",") and nothing else');
  }

  if (!/const\s+boundIds\s*=\s*boundMachineIds\(\s*state\s*\)\s*;/.test(src)) {
    out.push('the poll does not take its set from boundMachineIds(state)');
  }
  if (!/const\s+ids\s*=\s*boundIds\s*===\s*''\s*\?\s*\[\]\s*:\s*boundIds\.split\(\s*','\s*\)\.map\(\s*Number\s*\)\s*;/.test(src)) {
    out.push('the poll ids are not boundIds split back into numbers');
  }
  if (!/await\s+Promise\.all\(\s*ids\.map\(\s*ask\s*\)\s*\)/.test(src)) {
    out.push('the poll does not ask about exactly ids');
  }
  const reads = src.match(/\breadAppliedConfig\(/g) ?? [];
  if (reads.length !== 1 || !/const\s+ask\s*=\s*async\s*\(\s*node\s*:\s*number\s*\)[\s\S]*?readAppliedConfig\(\s*node\s*\)/.test(src)) {
    out.push(`readAppliedConfig is called ${reads.length} times, or outside ask(node)`);
  }
  if (!/answersForFrame\(\s*answersRef\.current\s*,\s*boundMachineIds\(\s*stateRef\.current\s*\)/.test(src)) {
    out.push('the frame answers are not filtered by boundMachineIds');
  }
  return out;
}

describe('TutorialLayer polls the set boundMachineHandles names', () => {
  const source = readFileSync(LAYER, 'utf8');

  it('reads a real file', () => {
    expect(source).toContain('boundMachineIds');
  });

  it('the shipped layer has no breach', () => {
    expect(pollSetBreaches(source)).toEqual([]);
  });

  const mutations: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a hand-rolled filter in boundMachineIds',
      "boundMachineHandles(s.bindings).join(',')",
      "Object.values(s.bindings).map((b) => b.id).join(',')",
    ],
    ['the import dropped', "import { boundMachineHandles, lineDoorstep } from '../../tutorial/check';", "import { lineDoorstep } from '../../tutorial/check';"],
    ['the poll reading another set', 'const boundIds = boundMachineIds(state);', "const boundIds = '1,2';"],
    ['the poll asking about extra ids', 'ids.map(ask)', '[...ids, 0].map(ask)'],
    [
      'a second host read',
      'void read();',
      'void read(); void readAppliedConfig(0);',
    ],
    [
      'frame answers filtered by another set',
      'answersForFrame(answersRef.current, boundMachineIds(stateRef.current)',
      "answersForFrame(answersRef.current, '1'",
    ],
  ];

  for (const [name, from, to] of mutations) {
    it(`catches ${name}`, () => {
      expect(source).toContain(from);
      expect(pollSetBreaches(source.replace(from, to)).length).toBeGreaterThan(0);
    });
  }
});
