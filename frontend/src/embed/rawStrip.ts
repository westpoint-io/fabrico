// Takes the comments out of the raw text the read-only board bundle inlines, and fails the embed
// build if one gets in. vite.embed.config.ts installs `embedSvgStripPlugin`; rawStrip.test.ts runs
// its two hooks on planted files and chunks.
//
// The machine and transport SVGs come in through `?raw` imports, and their leading comments are
// design notes that cite internal planning records. The bundle is published (the docs site serves
// it and the offline examples file inlines it), so the `load` hook reads each `.svg?raw` file itself
// and returns the text with every HTML comment and the whitespace after it removed. Only comments
// go: the `<svg>` element and everything in it stay byte for byte, so the drawn art and every
// board's hash are the same. A file with a comment opener and no closer is refused.
//
// Any other `?raw` import is refused (review 101 WR-05). Its comments may not be HTML comments, so
// stripping `<!--` from it would neither be safe nor enough, and the bundle needs none today.
//
// `generateBundle` then reads every output chunk and throws if any still holds an HTML comment
// opener, so a new import, or a change to how Vite names one, can't put the notes back unnoticed.
// It looks for the opener as written and with its `<` escaped the ways a minifier writes it in a
// string (`\x3c`, `<`, `\u{3c}`, any case), and with the `!` escaped as `\!`.
//
// This is the embed build only. The app build (`vite.config.ts`) keeps its art as it is.

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/** An HTML comment and the whitespace after it. */
const HTML_COMMENT = /<!--[\s\S]*?-->\s*/g;

/** An HTML comment opener as output code can hold it: literal, or with `<` or `!` escaped. */
export const COMMENT_OPENER = /(?:<|\\x3c|\\u003c|\\u\{0*3c\})\\?!--/i;

/** The text of a `.svg?raw` file with its HTML comments removed, or an error for an unclosed one. */
export function stripSvgComments(text: string, name: string): string {
  const stripped = text.replace(HTML_COMMENT, '');
  if (COMMENT_OPENER.test(stripped)) {
    throw new Error(`fab-embed-svg-strip: ${name} has a comment opener with no closer`);
  }
  return stripped;
}

/** The plugin. `frontendRoot` is the folder file names in messages are relative to. */
export function embedSvgStripPlugin(frontendRoot: string): Plugin {
  return {
    name: 'fab-embed-svg-strip',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      const query = id.indexOf('?');
      if (query === -1) return null;
      if (!new URLSearchParams(id.slice(query + 1)).has('raw')) return null;
      const file = id.slice(0, query).replace(/^\0/, '');
      const name = path.relative(frontendRoot, file);
      if (!file.endsWith('.svg')) {
        throw new Error(
          `fab-embed-svg-strip: ${name}?raw is not an .svg file. The embed build strips comments only from .svg raw imports, so it refuses any other raw import rather than publish its comments.`,
        );
      }
      return `export default ${JSON.stringify(stripSvgComments(fs.readFileSync(file, 'utf8'), name))};`;
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk' && COMMENT_OPENER.test(chunk.code)) {
          const at = COMMENT_OPENER.exec(chunk.code)?.[0] ?? '<!--';
          throw new Error(`fab-embed-svg-strip: ${chunk.fileName} still holds an HTML comment opener (${at})`);
        }
      }
    },
  };
}
