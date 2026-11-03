// build-offline.ts - wraps the embed bundle into self-contained HTML pages.
//
// MODE `--pages <templates-dir> <out-dir>`: for each `*.html` in the templates folder, replace the
// marker comment `<!-- fabrico:bundle -->` with the bundle (`dist-embed/fabrico-board.js`) in one
// classic inline `<script>`, add the page's Content-Security-Policy meta tag to the head, and write
// the page to the out folder under the same name. Classic inline scripts are the one kind every
// engine runs from a file:// page; module scripts and fetches of sibling files are blocked there.
//
// The policy is `default-src 'none'`, so a fetch, worker or remote image fails in the browser
// itself. `'wasm-unsafe-eval'` lets the page compile the inlined player module, and
// `'unsafe-inline'` lets it run its one inline script.
//
// Paths on the command line are taken relative to the working directory; the bundle is found from
// this file's own location.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_MARKER = '<!-- fabrico:bundle -->';
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;

const BUNDLE_PATH = fileURLToPath(new URL('../dist-embed/fabrico-board.js', import.meta.url));

/**
 * The bundle as the body of an inline script element. A `</script` anywhere in it would end the
 * element early, so each one becomes `<\/script`, which reads the same inside a JavaScript string.
 */
export function inlineScript(bundle: string): string {
  const escaped = bundle.replace(/<\/script/gi, '<\\/script');
  // `<!--` followed later by `<script` puts the HTML parser in a state where the closing tag
  // below no longer ends the element. Refuse rather than ship a page that never runs.
  if (/<!--/.test(escaped) && /<script/i.test(escaped)) {
    throw new Error('build-offline: the bundle holds both "<!--" and "<script", which breaks inline script parsing');
  }
  return `<script>${escaped}</script>`;
}

/** One template page with the bundle and the policy put in. */
export function buildPage(template: string, bundle: string, name: string): string {
  if (!template.includes(BUNDLE_MARKER)) {
    throw new Error(`build-offline: ${name} has no ${BUNDLE_MARKER} marker`);
  }
  const charset = /<meta charset="utf-8">/i.exec(template);
  const head = /<head>/i.exec(template);
  const at = charset ? charset.index + charset[0].length : head ? head.index + head[0].length : -1;
  if (at < 0) throw new Error(`build-offline: ${name} has no <head>`);
  const withCsp = `${template.slice(0, at)}\n${CSP_META}${template.slice(at)}`;
  // A function replacement, so `$&` and friends in the bundle stay literal.
  return withCsp.replace(BUNDLE_MARKER, () => inlineScript(bundle));
}

function buildPages(templatesDir: string, outDir: string): number {
  const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
  const names = fs.readdirSync(templatesDir).filter((n) => n.endsWith('.html')).sort();
  if (names.length === 0) throw new Error(`build-offline: ${templatesDir} holds no .html page`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const template = fs.readFileSync(path.join(templatesDir, name), 'utf8');
    fs.writeFileSync(path.join(outDir, name), buildPage(template, bundle, name));
  }
  return names.length;
}

if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
  const [mode, templatesDir, outDir] = process.argv.slice(2);
  if (mode !== '--pages' || templatesDir === undefined || outDir === undefined) {
    console.error('usage: node scripts/build-offline.ts --pages <templates-dir> <out-dir>');
    process.exit(2);
  }
  buildPages(templatesDir, outDir);
}
