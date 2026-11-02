import { defineConfig } from 'vitest/config';

// The specs that need a built WebAssembly player. They sit outside `src/`, so the general
// `vitest run` can't reach them and fail for want of a build. Run them through
// `scripts/check-wasm-player.sh`, which passes the module's path and the native dump's. The verbose
// reporter prints each spec's name, so a run's output lists the boards it covered.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['player-tests/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
