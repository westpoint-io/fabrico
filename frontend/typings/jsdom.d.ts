// AMBIENT TYPES for `jsdom`, the HTML parser the docs suite's link check reads the built site with.
//
// One caller: `e2e-docs/links.spec.ts` parses every HTML file under `site/dist/` and walks the
// elements that carry a link. `jsdom` is already pinned in `package.json` and ships no
// declaration, and adding `@types/jsdom` would change the lockfile, so without this file the import
// is a TS7016 implicit-any error.
//
// TYPED RATHER THAN SILENCED, the rule this directory follows. The shape below is the subset the
// spec calls: the constructor and `window.document`, typed as the DOM's own `Document`. Widen it
// when a caller needs more, never to make an error go away.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string; contentType?: string });
    readonly window: { readonly document: Document; close(): void };
  }
}
