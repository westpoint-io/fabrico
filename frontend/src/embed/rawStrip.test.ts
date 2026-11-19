import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMMENT_OPENER, embedSvgStripPlugin, stripSvgComments } from './rawStrip';

// The embed bundle's comment guard (review 101 WR-05): its `load` hook strips comments from
// `.svg?raw` files and refuses any other raw import, and its `generateBundle` hook refuses a chunk
// that still holds an HTML comment opener, written plainly or escaped.

type LoadHook = (id: string) => string | null;
type BundleHook = (options: unknown, bundle: Record<string, unknown>) => void;

/** The plugin's two hooks as plain functions. */
function hooks(root: string): { load: LoadHook; generateBundle: BundleHook } {
  const plugin = embedSvgStripPlugin(root);
  return { load: plugin.load as unknown as LoadHook, generateBundle: plugin.generateBundle as unknown as BundleHook };
}

/** A one-chunk bundle holding `code`. */
const bundleOf = (code: string): Record<string, unknown> => ({
  'fabrico-board.js': { type: 'chunk', fileName: 'fabrico-board.js', code },
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-strip-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('load', () => {
  it('strips every comment from an .svg?raw file and keeps the svg byte for byte', () => {
    const svg = '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>\n';
    fs.writeFileSync(path.join(dir, 'art.svg'), `<!-- design note, phase 12 -->\n${svg.replace('<rect', '<!-- inner -->  <rect')}`);
    const out = hooks(dir).load(`${path.join(dir, 'art.svg')}?raw`);
    expect(out).toBe(`export default ${JSON.stringify(svg)};`);
  });

  it('refuses an .svg?raw file with a comment opener and no closer', () => {
    fs.writeFileSync(path.join(dir, 'open.svg'), '<svg></svg>\n<!-- never closed\n');
    expect(() => hooks(dir).load(`${path.join(dir, 'open.svg')}?raw`)).toThrow(
      'fab-embed-svg-strip: open.svg has a comment opener with no closer',
    );
  });

  it('refuses a ?raw import of any other file type', () => {
    for (const name of ['notes.md', 'page.html', 'text.txt']) {
      fs.writeFileSync(path.join(dir, name), '<!-- internal note -->\nbody\n');
      expect(() => hooks(dir).load(`${path.join(dir, name)}?raw`), name).toThrow(`fab-embed-svg-strip: ${name}?raw is not an .svg file`);
    }
  });

  it('leaves an import without ?raw to the next loader', () => {
    fs.writeFileSync(path.join(dir, 'art.svg'), '<!-- note --><svg></svg>');
    expect(hooks(dir).load(path.join(dir, 'art.svg'))).toBeNull();
    expect(hooks(dir).load(`${path.join(dir, 'art.svg')}?url`)).toBeNull();
  });
});

describe('generateBundle', () => {
  it('passes a chunk with no comment opener', () => {
    expect(() => hooks(dir).generateBundle({}, bundleOf('const a = "<svg></svg>"; const b = "a<b";'))).not.toThrow();
  });

  it('refuses a chunk holding a literal opener', () => {
    expect(() => hooks(dir).generateBundle({}, bundleOf('const a = "<!-- note -->";'))).toThrow(
      'fab-embed-svg-strip: fabrico-board.js still holds an HTML comment opener (<!--)',
    );
  });

  it('refuses a chunk holding an opener a minifier escaped', () => {
    for (const escaped of ['\\x3c!--', '\\x3C!--', '\\u003c!--', '\\u003C!--', '\\u{3c}!--', '\\u{003C}!--', '<\\!--']) {
      expect(() => hooks(dir).generateBundle({}, bundleOf(`const a = "${escaped} note";`)), escaped).toThrow(
        'still holds an HTML comment opener',
      );
    }
  });
});

describe('stripSvgComments and COMMENT_OPENER', () => {
  it('strip only comments and spot an escaped opener left in the text', () => {
    expect(stripSvgComments('<!-- a -->\n<svg/>', 'x.svg')).toBe('<svg/>');
    expect(() => stripSvgComments('<svg>\\x3c!-- a</svg>', 'x.svg')).toThrow('has a comment opener with no closer');
    expect(COMMENT_OPENER.test('a <!- b -> c')).toBe(false);
  });
});
