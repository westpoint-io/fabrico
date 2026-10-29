// AMBIENT TYPES for the PNG decoder `@playwright/test` already bundles.
//
// Three specs reach `playwright-core/lib/utilsBundle` for `PNG` rather than installing
// a second decoder (`e2e/chrome-bezel.spec.ts`, `e2e/dpr-crispness.spec.ts`,
// `e2e-live/06-fault-red-probe.spec.ts`). That module is plain JavaScript inside
// `playwright-core` with no shipped declaration, so once `e2e/` and `e2e-live/` entered
// `tsconfig.json`'s include it became three TS7016 implicit-any errors.
//
// TYPED RATHER THAN SILENCED. `declare module '...';` with no body, or a `@ts-expect-error`
// at each import, would have made tsc quiet while leaving every `png.data[i]` an `any` -
// which is the same gate-excludes-what-it-cannot-check defect that widening the include
// was meant to close. The shape below is the SUBSET the three specs actually call, and
// `data` is a `Buffer` because `06-fault-red-probe.spec.ts:495` passes it to a
// `(data: Buffer)` parameter. Widen it when a spec needs more, never to make an error go
// away.
declare module 'playwright-core/lib/utilsBundle' {
  export const PNG: {
    sync: {
      read(buffer: Buffer): { width: number; height: number; data: Buffer };
    };
  };
}
