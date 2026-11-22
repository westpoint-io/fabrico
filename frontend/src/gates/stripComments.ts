// stripComments.ts - blank out the comments of a TypeScript source read as text.
//
// The source-text tests that read another file AS TEXT (HintPointer.test.ts,
// lessonCoverage.source.test.ts, tutorialPurity.source.test.ts) use it so a word in a comment
// can't satisfy or trip their checks. It lives in a non-test module because a `.test.ts` file
// is not something another test should import.

/**
 * Blank out comments, PRESERVING every newline so line numbers survive.
 *
 * A character scanner rather than a regex, because the spec's copy contains apostrophes
 * and slashes and a regex sweep over `/* ... *\/` can be opened by either.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const keepNewlines = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === ch) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}
