// AMBIENT TYPES for `fontkit`, the font parser the lockup generator reads outlines with.
//
// One caller: `scripts/build-lockup.ts` opens the decompressed `MartianMono.woff2`,
// instances the `wght` axis at 500 for the word and 400 for the tagline, and walks each
// glyph's path commands into flat SVG geometry. `fontkit` 2.0.4 ships no declaration and
// `tsconfig.json` includes both `scripts` and `typings`, so without this file the import is
// a TS7016 implicit-any error.
//
// TYPED RATHER THAN SILENCED. `declare module 'fontkit';` with no body, or a
// `@ts-expect-error` at the import, would have made tsc quiet while leaving every
// `command.args[i]` an `any` - which is the same gate-excludes-what-it-cannot-check defect
// the sibling declaration in this directory was written to close. The shape below is the
// SUBSET `build-lockup.ts` actually calls: `create`, `getVariation`, `layout`,
// `unitsPerEm`, `xHeight`, `familyName`, and on a glyph `path.commands`, `path.toSVG()` and
// `path.bbox`. Widen it when the generator needs more, never to make an error go away.
//
// `create()` is typed as returning a `Font` rather than a `WOFF2Font` union deliberately:
// the generator never hands `create()` a WOFF2 (fontkit cannot instance one, 80-RESEARCH.md
// section 1 result 1), it hands it the TTF `wawoff2.decompress()` returned.
declare module 'fontkit' {
  /** One command of a glyph outline, in font units with y pointing up. */
  export interface PathCommand {
    command: string;
    args: number[];
  }

  export interface PathBBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }

  export interface GlyphPath {
    commands: PathCommand[];
    bbox: PathBBox;
    toSVG(): string;
  }

  export interface Glyph {
    id: number;
    path: GlyphPath;
    advanceWidth: number;
  }

  export interface GlyphPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface GlyphRun {
    glyphs: Glyph[];
    positions: GlyphPosition[];
    advanceWidth: number;
  }

  export interface Font {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    capHeight: number;
    xHeight: number;
    familyName: string;
    postscriptName: string;
    numGlyphs: number;
    layout(str: string): GlyphRun;
    /** Returns a new Font instanced on the named variation axes. Never call on a WOFF2. */
    getVariation(coords: Record<string, number>): Font;
  }

  export function create(buffer: Buffer | Uint8Array): Font;
}
