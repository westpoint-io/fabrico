import { describe, expect, it } from 'vitest';
import { badgeText, badgeTitle, isFailure, verdictOf } from './badge';
import { formatTick, tickText } from './controls';

const HASH = '3fa9c21b' + 'a'.repeat(56);
const OTHER = '9c0d44e1' + 'b'.repeat(56);

describe('verdictOf', () => {
  it('reads match when the hash equals the pinned value', () => {
    expect(verdictOf(HASH, { endTick: 1200, hash: HASH })).toBe('match');
  });
  it('reads mismatch when one character differs', () => {
    const changed = HASH.slice(0, 63) + (HASH[63] === 'a' ? 'b' : 'a');
    expect(verdictOf(changed, { endTick: 1200, hash: HASH })).toBe('mismatch');
  });
  it('reads not pinned when the manifest has no line for the board', () => {
    expect(verdictOf(HASH, null)).toBe('not pinned');
    expect(verdictOf(HASH, null, 'reversed')).toBe('not pinned');
  });
  it('reads a reversed run off the file-order pin as order-dependent, which is not a failure', () => {
    expect(verdictOf(OTHER, { endTick: 1200, hash: HASH }, 'reversed')).toBe('order-dependent');
    expect(verdictOf(HASH, { endTick: 1200, hash: HASH }, 'reversed')).toBe('match');
    expect(verdictOf(OTHER, { endTick: 1200, hash: HASH }, 'forward')).toBe('mismatch');
    expect(isFailure('order-dependent')).toBe(false);
    expect(isFailure('mismatch')).toBe(true);
  });
});

describe('badgeText', () => {
  it('reads final state and 8 middle dots before the end tick', () => {
    expect(badgeText({ hash: null, verdict: null })).toBe('final state ········');
  });
  it('reads the first 8 hash characters and the verdict after it', () => {
    expect(badgeText({ hash: HASH, verdict: 'match' })).toBe('final state 3fa9c21b match');
    expect(badgeText({ hash: HASH, verdict: 'mismatch' })).toBe('final state 3fa9c21b mismatch');
    expect(badgeText({ hash: HASH, verdict: 'not pinned' })).toBe('final state 3fa9c21b not pinned');
  });
});

describe('badgeTitle', () => {
  it('uses the UI-SPEC copy for each verdict', () => {
    expect(badgeTitle('match', { endTick: 1200, hash: HASH })).toBe(
      "The engine's state hash at the last tick. It equals the value pinned for this board, so this run ended exactly where every run of it ends.",
    );
    expect(badgeTitle('mismatch', { endTick: 1200, hash: OTHER })).toBe(
      'Pinned value is 9c0d44e1. This run ended somewhere else, which is a bug: report it with the board name.',
    );
    expect(badgeTitle('not pinned', null)).toBe(
      'examples/boards/hashes.manifest has no entry for this board, so nothing can check it.',
    );
    expect(badgeTitle('order-dependent', { endTick: 1200, hash: OTHER })).toBe(
      "The file-order run is pinned at 9c0d44e1. This run fed same-tick events in reverse order and ended somewhere else, so this board's result depends on the order its events arrive in.",
    );
  });
});

describe('the tick counter', () => {
  it('formats with en-US separators', () => {
    expect(formatTick(1204)).toBe('1,204');
    expect(formatTick(68)).toBe('68');
  });
  it('reads tick {current} / {end}', () => {
    expect(tickText(412, 900)).toBe('tick 412 / 900');
    expect(tickText(1204, 3000)).toBe('tick 1,204 / 3,000');
  });
});
