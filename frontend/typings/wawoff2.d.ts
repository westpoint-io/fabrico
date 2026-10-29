// AMBIENT TYPES for `wawoff2`, the WOFF2 decoder the lockup generator runs before fontkit.
//
// One caller: `scripts/build-lockup.ts`. WOFF2 is not brotli-of-a-TTF - its `glyf` and
// `loca` tables are transformed and have to be reconstructed - and fontkit cannot instance
// a variable axis over a WOFF2 at all (80-RESEARCH.md section 1 result 1). So the committed
// 23,556-byte `MartianMono.woff2` is decompressed to a TTF first, and fontkit reads that.
// `wawoff2` 2.0.1 is fontello's Emscripten build of Google's woff2 library: CommonJS, no
// native compile, no postinstall. It ships no declaration, and `tsconfig.json` includes
// `scripts` and `typings`, so without this file the import is a TS7016 implicit-any error.
//
// TYPED RATHER THAN SILENCED, the rule this directory was opened with. `declare module
// 'wawoff2';` with no body would have made tsc quiet while leaving the decompressed bytes an
// `any` handed straight to `fontkit.create()`, which is the one place a wrong type would go
// unnoticed until the glyph walk produced nonsense. The subset below is what the generator
// calls: `decompress` only. `compress` exists in the package and is deliberately absent -
// nothing in this repository writes a WOFF2.
declare module 'wawoff2' {
  export function decompress(buffer: Buffer | Uint8Array): Promise<Uint8Array>;
}
