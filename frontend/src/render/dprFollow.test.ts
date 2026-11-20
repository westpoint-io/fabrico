import { describe, expect, it } from 'vitest';
import { createDprFollower, type ResolutionTarget } from './dprFollow.ts';

// dprFollow.test.ts - the pixel-ratio follower, driven with fakes.
//
// The follower runs once per frame on the Pixi ticker and resizes the renderer's backing
// store when `devicePixelRatio` stops matching the renderer's resolution. `bootPixi` can't
// run under vitest's node environment (no window, no WebGL), so the follower is a pure
// function over three inputs and this file drives it with a recording fake renderer. The
// wiring into `bootPixi` is proved in the browser by `e2e/dpr-follow.spec.ts`.

/** A recording stand-in for `app.renderer`: resize sets the resolution, as Pixi's does. */
class FakeTarget implements ResolutionTarget {
  calls: Array<[number, number, number]> = [];
  constructor(public resolution: number) {}
  resize(width: number, height: number, resolution: number): void {
    this.calls.push([width, height, resolution]);
    this.resolution = resolution;
  }
}

const CSS = { width: 1280, height: 720 };

describe('createDprFollower', () => {
  it('makes no resize call on a tick where the ratio equals the resolution', () => {
    const target = new FakeTarget(1);
    const follow = createDprFollower(() => 1, target, () => CSS);
    follow();
    follow();
    expect(target.calls).toEqual([]);
  });

  it('makes one resize call with the CSS size after the ratio changes to 2', () => {
    let dpr = 1;
    const target = new FakeTarget(1);
    const follow = createDprFollower(() => dpr, target, () => CSS);
    follow();
    dpr = 2;
    follow();
    expect(target.calls).toEqual([[1280, 720, 2]]);
  });

  it('makes no further call on a second tick at the same new ratio', () => {
    let dpr = 1;
    const target = new FakeTarget(1);
    const follow = createDprFollower(() => dpr, target, () => CSS);
    dpr = 2;
    follow();
    follow();
    follow();
    expect(target.calls).toHaveLength(1);
  });

  it('reads the CSS size at the moment of the change, not at creation', () => {
    let dpr = 1;
    let size = { width: 800, height: 600 };
    const target = new FakeTarget(1);
    const follow = createDprFollower(() => dpr, target, () => size);
    size = { width: 1024, height: 768 };
    dpr = 2;
    follow();
    expect(target.calls).toEqual([[1024, 768, 2]]);
  });

  it('follows 1, 2, 1.181793212890625, 1 with exactly three calls, resolutions in order', () => {
    const sequence = [1, 2, 1.181793212890625, 1];
    let dpr = sequence[0];
    const target = new FakeTarget(1);
    const follow = createDprFollower(() => dpr, target, () => CSS);
    for (const r of sequence) {
      dpr = r;
      // Two ticks per ratio: the second must be a no-op.
      follow();
      follow();
    }
    expect(target.calls.map((c) => c[2])).toEqual([2, 1.181793212890625, 1]);
    expect(target.resolution).toBe(1);
  });

  it.each([
    ['0', 0],
    ['NaN', Number.NaN],
    ['a negative number', -2],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('treats a ratio of %s as 1', (_label, bad) => {
    // At resolution 1 a bad read is a no-op...
    const atOne = new FakeTarget(1);
    createDprFollower(() => bad, atOne, () => CSS)();
    expect(atOne.calls).toEqual([]);
    // ...and at resolution 2 it resizes to 1, once, never to the bad value.
    const atTwo = new FakeTarget(2);
    const follow = createDprFollower(() => bad, atTwo, () => CSS);
    follow();
    follow();
    expect(atTwo.calls).toEqual([[1280, 720, 1]]);
  });
});
