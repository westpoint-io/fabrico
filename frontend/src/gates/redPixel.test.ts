import { describe, expect, it } from 'vitest';
import { isRedPixel, redPixelCount } from '../../shared/redPixel';
import { LOCKED_SKIN } from '../render/synth/skins/locked';
import { LABEL_COLOURS } from '../render/synth/skin';
import { FRAMES, faultBlinkAlpha } from '../render/faultBlink';
import { LOD_TINTS } from '../render/layers/lodTints';

// redPixel.test.ts (phase 92 review WR-B-06) - pins what the shared red predicate sees, so a whole-
// board red count of 0 means "nothing red", not "nothing near today's fault accent".

const rgb = (c: number): [number, number, number] => [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
const over = (fg: number, bg: number, a: number): [number, number, number] => {
  const f = rgb(fg);
  const b = rgb(bg);
  return [0, 1, 2].map((i) => Math.round(b[i] + a * (f[i] - b[i]))) as [number, number, number];
};
const { ramp, accents, labels, cable } = LOCKED_SKIN.palette;
/** The phase's first predicate (`87-factory-two-emits`), kept here only to show what it missed. */
const offsetRed = (r: number, g: number, b: number): boolean => r >= g + 25 && b >= g + 5 && r >= b;

describe('the red predicate sees red by hue (phase 92 review WR-B-06)', () => {
  it('sees the fault accent at every alpha of its blink over the floor and the minor grid line', () => {
    const alphas = new Set<number>();
    for (let f = 0; f < FRAMES; f += 1) alphas.add(faultBlinkAlpha(f));
    alphas.add(1);
    expect(alphas.size, 'the cadence has more than one alpha').toBeGreaterThan(2);
    for (const bg of [ramp[0], ramp[1]]) {
      for (const a of alphas) {
        expect(isRedPixel(...over(accents.fault, bg, a)), `fault at alpha ${a} over 0x${bg.toString(16)}`).toBe(true);
      }
    }
  });

  it('sees a brick red and a pure red, which the channel-offset predicate missed', () => {
    for (const c of [0xbc4e4e, 0xff0000, 0xc04040]) {
      expect(isRedPixel(...rgb(c)), `0x${c.toString(16)} is red`).toBe(true);
      expect(offsetRed(...rgb(c)), `NON-VACUITY: the old predicate missed 0x${c.toString(16)}`).toBe(false);
    }
  });

  it('does not count the Merge magenta, which the channel-offset predicate counted', () => {
    expect(isRedPixel(...rgb(LOD_TINTS.merge)), 'the Merge tint is magenta, not red').toBe(false);
    expect(offsetRed(...rgb(LOD_TINTS.merge)), 'NON-VACUITY: the old predicate counted it').toBe(true);
  });

  it('does not count the cable, the other accents or any ramp step', () => {
    const named: [string, number][] = [
      ['cable', cable],
      ['item', accents.item],
      ['working', accents.working],
      ['build', accents.build],
      ['electric', accents.electric],
      ...ramp.map((c, i): [string, number] => [`ramp[${i}]`, c]),
    ];
    for (const [name, c] of named) expect(isRedPixel(...rgb(c)), `${name} is not red`).toBe(false);
  });

  it('counts one Label colour, clay, and no other', () => {
    const red = LABEL_COLOURS.filter((n) => isRedPixel(...rgb(labels[n])));
    expect(red, 'clay (hue 18) is the one Label colour that reads red; rose (hue 329) does not').toEqual(['clay']);
  });

  it('counts an RGBA buffer pixel by pixel', () => {
    const buf = new Uint8Array([...rgb(accents.fault), 255, ...rgb(ramp[0]), 255, 255, 0, 0, 255, ...rgb(LOD_TINTS.merge), 255]);
    expect(redPixelCount(buf)).toBe(2);
  });
});
