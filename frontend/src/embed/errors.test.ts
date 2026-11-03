// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildErrorCard, classifyPlayerError, errorCopy, unknownBoardCopy } from './errors';

// The player's own error texts, as the Rust crates write them.
const FORMAT_1 = 'the board file has format 1, and this build reads format 2';
const STEP_ERROR = "the script entry at tick 120 names handle 42, which isn't minted yet";
const TRAPPED = 'the player instance trapped and can take no more calls, so load a new one';

describe('classifyPlayerError', () => {
  it('reads the Rust "has format N" text as the old-format card', () => {
    expect(classifyPlayerError(FORMAT_1, 'create')).toEqual({ kind: 'old-format', format: 1 });
    expect(classifyPlayerError('the board file has format 7, and this build reads format 2', 'create')).toEqual({
      kind: 'old-format',
      format: 7,
    });
  });

  it('reads an error from step as the engine stopping', () => {
    expect(classifyPlayerError(STEP_ERROR, 'step')).toEqual({ kind: 'engine-stopped' });
  });

  it('reads a trapped player as the engine stopping, wherever it happens', () => {
    expect(classifyPlayerError(TRAPPED, 'step')).toEqual({ kind: 'engine-stopped' });
    expect(classifyPlayerError(TRAPPED, 'create')).toEqual({ kind: 'engine-stopped' });
  });

  it('reads any other create error as a board that did not load', () => {
    expect(classifyPlayerError('expected `(` at 3:1', 'create')).toEqual({ kind: 'load-failed' });
  });
});

describe('the card copy', () => {
  it('names an unknown board', () => {
    expect(unknownBoardCopy('demo_scen')).toEqual({
      heading: 'BOARD DID NOT LOAD',
      body: 'There\'s no board named "demo_scen" in this bundle. Check the name attribute against the files in examples/boards/.',
    });
  });

  it('names the old format', () => {
    expect(errorCopy({ kind: 'old-format', format: 1 }, { message: FORMAT_1, tick: 0 })).toEqual({
      heading: 'BOARD DID NOT LOAD',
      body: 'This board file is format 1, and this player reads format 2. Update the file to format 2 and give it a captions list.',
    });
  });

  it('names the tick and the reason when the engine stops', () => {
    expect(errorCopy({ kind: 'engine-stopped' }, { message: STEP_ERROR, tick: 120 })).toEqual({
      heading: 'ENGINE STOPPED',
      body: "The engine stopped at tick 120: the script entry at tick 120 names handle 42, which isn't minted yet. Press Restart to run it again. If it stops at the same tick, report it with this board's name.",
    });
    expect(errorCopy({ kind: 'engine-stopped' }, { message: 'x', tick: 1204 }).body).toContain('at tick 1,204: x.');
  });
});

describe('buildErrorCard', () => {
  it('sets every word as text, so board text never becomes markup', () => {
    const card = buildErrorCard(unknownBoardCopy('<img src=x onerror=alert(1)>'));
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toContain('"<img src=x onerror=alert(1)>"');
    expect(card.querySelector('.card-heading')?.textContent).toBe('BOARD DID NOT LOAD');
    expect(card.querySelector('.card-heading svg')).not.toBeNull();
    expect(card.getAttribute('role')).toBe('alert');
  });
});
