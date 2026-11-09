// The description rule every docs page's frontmatter goes through while the site builds.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESCRIPTION_MAX, DESCRIPTION_MIN, descriptionError } from '../../src/lib/frontmatter.ts';

const NEEDS = 'This page needs a description of 50 to 160 characters in its frontmatter.';

test('the limits are 50 and 160 characters', () => {
  assert.equal(DESCRIPTION_MIN, 50);
  assert.equal(DESCRIPTION_MAX, 160);
});

test('a description of 50 or 160 characters passes', () => {
  assert.equal(descriptionError('a'.repeat(50)), null);
  assert.equal(descriptionError('a'.repeat(160)), null);
});

test('a description of 49 or 161 characters fails with its count', () => {
  assert.equal(descriptionError('a'.repeat(49)), `${NEEDS} It has 49.`);
  assert.equal(descriptionError('a'.repeat(161)), `${NEEDS} It has 161.`);
});

test('a missing description fails with "It has none."', () => {
  assert.equal(descriptionError(undefined), `${NEEDS} It has none.`);
});

test('length counts code points, not UTF-16 units', () => {
  // U+00E9 written as one code point: 50 code points, 50 UTF-16 units.
  assert.equal(descriptionError(`é${'a'.repeat(49)}`), null);
  // U+1F600 is one code point and two UTF-16 units: 50 code points, 51 units.
  const astral = `\u{1F600}${'a'.repeat(49)}`;
  assert.equal(astral.length, 51);
  assert.equal(descriptionError(astral), null);
  // 160 code points, 161 units: passes on code points, where .length would fail it.
  assert.equal(descriptionError(`\u{1F600}${'a'.repeat(159)}`), null);
  // 161 code points fails and says 161.
  assert.equal(descriptionError(`\u{1F600}${'a'.repeat(160)}`), `${NEEDS} It has 161.`);
});
