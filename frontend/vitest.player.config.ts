import { defineConfig } from 'vitest/config';

// The specs that need a built WebAssembly player. They sit outside `src/`, so the general
// `vitest run` can't reach them and fail for want of a build. Run them through
// `scripts/check-wasm-player.sh`, which passes the module's path.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['player-tests/**/*.test.ts'],
  },
});
