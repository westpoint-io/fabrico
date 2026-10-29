import { defineConfig } from 'vitest/config';

// Node environment: the tests this scaffold is built for are the hand-rolled
// postcard decoder (07-05) and the interpolation math (07-05/07-07) — pure
// logic, no DOM. The `test` npm script runs `vitest run` (single-shot, NO watch).
export default defineConfig({
  // THIS CONFIG DOES NOT INHERIT `vite.config.ts` - it is a separate file with its own
  // plugin set - so anything `vite.config.ts` injects has to be imported here rather
  // than assumed. Until plan 68-07 that meant one shared `define`, imported rather than
  // re-declared so the two configs could not disagree silently: the development pace
  // switch's build flag, which a unit test had to be able to evaluate as a real boolean
  // instead of a ReferenceError. That flag was removed with the switch (BELT-05 /
  // D-68-12) and this config now shares NO define with `vite.config.ts`. If one is ever
  // needed again, import it from there; do not re-declare it here.
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
