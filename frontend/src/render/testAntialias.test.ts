import { afterEach, describe, expect, it, vi } from 'vitest';

import { antialiasForBoot } from './testAntialias.ts';

// testAntialias.test.ts - the test antialiasing switch is read only in the dev server.
//
// `antialiasForBoot` decides the `antialias` option the board's WebGL context is created
// with. It may answer true only when `import.meta.env.DEV` is true AND the page URL names
// the flag. `vi.stubEnv` sets `import.meta.env.DEV` for one test; `vite build` folds the
// same value to false, which is what the last test stands in for. The bundle check
// (`scripts/check-test-aa-switch-absent.sh`) proves the folded build carries no flag.

describe('antialiasForBoot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('turns antialiasing on in the dev server when the URL carries the flag', () => {
    vi.stubEnv('DEV', true);
    expect(antialiasForBoot('?fab-test-antialias')).toBe(true);
  });

  it('keeps antialiasing off in the dev server when the URL carries no flag', () => {
    vi.stubEnv('DEV', true);
    expect(antialiasForBoot('')).toBe(false);
    expect(antialiasForBoot('?other=1')).toBe(false);
  });

  it('counts the flag by its presence, wherever it sits and whatever value it has', () => {
    vi.stubEnv('DEV', true);
    expect(antialiasForBoot('?a=1&fab-test-antialias=1')).toBe(true);
  });

  it('keeps antialiasing off outside the dev server even when the URL carries the flag', () => {
    vi.stubEnv('DEV', false);
    expect(antialiasForBoot('?fab-test-antialias')).toBe(false);
  });
});
