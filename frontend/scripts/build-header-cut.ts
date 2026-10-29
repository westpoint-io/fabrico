// build-header-cut.ts - the entry point for the header cut of the Fabrico lockup (MARK-17).
//
// WHAT THIS EMITS. `frontend/src/chrome/brand/fabrico-header.svg`, the drawing the application
// toolbar wears: the word `Fabrico` standing on the belt, with the amber item for the tittle of
// the `i`, on its own dark plate. Twelve paths, painted in app tokens, cropped to a header
// shaped window on the lockup's own coordinate space.
//
// WHY IT IS ITS OWN MODULE RATHER THAN A SECOND BLOCK IN `build-lockup.ts`. `import.meta.main`
// is true for the ENTRY module, so a second guarded block inside the generator would fire on
// the same bare `node scripts/build-lockup.ts` invocation as the first: `npm run build:lockup`
// would silently write two artefacts, and the two script keys would stop meaning different
// things. A thin second entry point keeps one command to one artefact. Importing
// `build-lockup.ts` from here writes nothing, because its own guard sees this file as the
// entry module.
//
// ALL THE GEOMETRY AND EVERY DECISION LIVES IN `build-lockup.ts`, on purpose. The cut and the
// brand lockup are emitted from ONE shared geometry function (`sharedLayers`), so moving a belt
// constant by one unit moves both files together. A second generator that re-derived even one
// of those paths would leave that path unproved.
//
// NO PATH INPUT, EVER, following `build-lockup.ts`, `mark-craft.ts` and `lint-svg.ts`. This
// module reads no argv and no cwd; the output path is resolved from `import.meta.url` inside
// `writeHeaderCut`. Adding argv parsing here would reopen exactly what those files refuse.
//
// ERASURE-ONLY TYPESCRIPT, with an explicit `.ts` extension on the relative import. Node runs
// this file directly through native type stripping.
//
// NO EM DASH (U+2014) ANYWHERE IN THIS FILE OR IN ANYTHING IT EMITS.

import { round3, writeHeaderCut } from './build-lockup.ts';

// `import.meta.main` is true only under bare `node scripts/build-header-cut.ts`; under Vite and
// vitest it is undefined, so importing this module never writes a file. Deliberately NOT an
// argv comparison: this entry point reads no argv at all.
if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const built = await writeHeaderCut();
  process.stdout.write(
    `build-header-cut  ${built.paths} paths, ${built.svg.length} bytes, ` +
      `crop ${round3(built.crop.x)} ${round3(built.crop.y)} ` +
      `${round3(built.crop.w)} ${round3(built.crop.h)}\n`,
  );
  if (built.paths === 0) process.exitCode = 1;
}
