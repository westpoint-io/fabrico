// build-offline.ts - wraps the embed bundle into self-contained HTML pages.
//
// DEFAULT MODE (no arguments): writes `dist-examples/fabrico-examples.html`, the one file that runs
// every example board when a reader opens it from disk. It holds the bundle, both fonts, the
// lockup, page styles from the app's own tokens, a list of in-page links to the boards, and one
// section per `*.board.ron` under `examples/boards/`, in path order. A section's id is the board
// id (the path under `examples/boards/` without `.board.ron`, `/` turned into `-`), its heading is
// the board's own `title`, and it ends with a link back to the list. A board added under
// `examples/boards/` joins the file on the next build with no change here.
//
// The titles come from the player itself: this script loads the player module named by
// FABRICO_PLAYER_WASM in Node and asks each board for its info, so nothing here parses a board
// file. The player loader and the style modules are TypeScript that plain Node can't strip, so
// they are loaded through Vite's module runner.
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
// Paths on the command line are taken relative to the working directory; the bundle, the boards,
// the fonts and the lockup are found from this file's own location.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_MARKER = '<!-- fabrico:bundle -->';
export const PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">`;

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const BUNDLE_PATH = path.join(FRONTEND, 'dist-embed', 'fabrico-board.js');
const BOARDS_DIR = path.join(REPO, 'examples', 'boards');
const LOCKUP_PATH = path.join(REPO, 'docs', 'brand', 'fabrico-lockup.svg');

/** Where the default mode writes the offline file. */
export const EXAMPLES_FILE = path.join(FRONTEND, 'dist-examples', 'fabrico-examples.html');
/** The id of the board list, which every section's back link points at. */
export const BOARD_LIST_ID = 'board-list';
/** The lockup's height on the page, in CSS px. */
const LOCKUP_HEIGHT_PX = 32;

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

// --- The offline file ---

/** A board as the offline file lists it. */
export interface ExampleBoard {
  /** `docs/x.board.ron` is `docs-x`. The section's id and the element's `name`. */
  id: string;
  /** The path under the repo root, `examples/boards/...`. */
  path: string;
  /** The board's own title, from the player. */
  title: string;
}

/**
 * Every `*.board.ron` under `examples/boards/`, at any depth, as `{ id, path }`, in byte-wise path
 * order (the order `hashes.manifest` and the bundle use).
 */
export function exampleBoardFiles(dir: string = BOARDS_DIR): { id: string; path: string }[] {
  const found: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name);
      const child = rel === '' ? name : `${rel}/${name}`;
      if (fs.statSync(full).isDirectory()) walk(full, child);
      else if (name.endsWith('.board.ron')) found.push(child);
    }
  };
  walk(dir, '');
  found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return found.map((rel) => ({
    id: rel.slice(0, -'.board.ron'.length).replace(/\//g, '-'),
    path: `examples/boards/${rel}`,
  }));
}

/** Text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The lockup drawing, ready to inline: the XML declaration and comments dropped, and the root
 * given a size of 32 px tall (width from its viewBox), an image role and the name "Fabrico".
 */
export function inlineLockup(svg: string): string {
  const body = svg.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const root = /<svg\b([^>]*)>/.exec(body);
  if (root === null) throw new Error('build-offline: the lockup has no <svg> root');
  const viewBox = /viewBox="([^"]+)"/.exec(root[1]);
  const parts = viewBox?.[1].trim().split(/[\s,]+/).map(Number);
  if (parts === undefined || parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) {
    throw new Error('build-offline: the lockup has no usable viewBox');
  }
  const width = Math.round(((LOCKUP_HEIGHT_PX * parts[2]) / parts[3]) * 100) / 100;
  const attrs = root[1].replace(/\s(width|height|role|aria-label|class)="[^"]*"/g, '');
  const open = `<svg${attrs} class="lockup" width="${width}" height="${LOCKUP_HEIGHT_PX}" role="img" aria-label="Fabrico">`;
  return open + body.slice(root.index + root[0].length);
}

/** The page's own rules. Tokens only, from the UI-SPEC's offline page rows. */
const PAGE_CSS = `
html { background: var(--fab-substrate); }
body {
  margin: 0;
  background: var(--fab-substrate);
  color: var(--fab-ink);
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1.4;
}
main {
  max-width: 960px;
  margin: 0 auto;
  padding: var(--fab-space-2xl) var(--fab-space-lg);
}
.fab-title {
  font-family: var(--fab-font-title);
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 0.5px;
}
header {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--fab-space-lg);
}
.lockup { display: block; }
h1, h2, p { margin: 0; }
h1.fab-title, section h2.fab-title { font-size: var(--fab-font-size-hero); line-height: 1.2; }
nav { margin-top: var(--fab-space-2xl); scroll-margin-top: var(--fab-space-lg); }
nav h2.fab-title { font-size: var(--fab-font-size-base); line-height: 1; margin-bottom: var(--fab-space-sm); }
nav ul { list-style: none; margin: 0; padding: 0; }
section { margin-top: var(--fab-space-2xl); scroll-margin-top: var(--fab-space-lg); }
section h2.fab-title { margin-bottom: var(--fab-space-md); }
a {
  color: var(--fab-ink);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--fab-focus); outline-offset: 2px; }
nav a, .back {
  display: inline-flex;
  align-items: center;
  min-height: var(--fab-min-target);
}
.back { margin-top: var(--fab-space-sm); }
`;

const INTRO =
  "Every example board in this release, running on the real engine inside this file. Press Play on any board. This page doesn't connect to the network.";

/** What the offline file is made from. Everything is text; the function does no I/O. */
export interface ExamplesPageParts {
  boards: readonly ExampleBoard[];
  bundle: string;
  /** The `@font-face` rules, with both faces as `data:` URLs. */
  fontCss: string;
  /** The `--fab-*` tokens under `:root`. */
  tokenCss: string;
  /** The lockup drawing's file text. */
  lockupSvg: string;
}

/** The offline file's text. */
export function examplesPage(parts: ExamplesPageParts): string {
  if (parts.boards.length === 0) throw new Error('build-offline: there are no boards for the offline file');
  const ids = new Set<string>();
  for (const board of parts.boards) {
    if (board.id === BOARD_LIST_ID) throw new Error(`build-offline: a board's id is "${BOARD_LIST_ID}", the board list's id`);
    if (ids.has(board.id)) throw new Error(`build-offline: two boards share the id "${board.id}"`);
    if (board.title.trim() === '') throw new Error(`build-offline: ${board.path} has no title`);
    ids.add(board.id);
  }
  const links = parts.boards
    .map((b) => `      <li><a href="#${escapeHtml(b.id)}" data-board-link="${escapeHtml(b.id)}">${escapeHtml(b.title)}</a></li>`)
    .join('\n');
  const sections = parts.boards
    .map(
      (b) => `  <section id="${escapeHtml(b.id)}" data-board="${escapeHtml(b.id)}">
    <h2 class="fab-title">${escapeHtml(b.title)}</h2>
    <fabrico-board name="${escapeHtml(b.id)}"></fabrico-board>
    <a class="back" href="#${BOARD_LIST_ID}">Back to the list</a>
  </section>`,
    )
    .join('\n');
  const template = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fabrico examples</title>
<style data-fabrico-fonts>
${parts.fontCss}
</style>
<style>
${parts.tokenCss}
${PAGE_CSS}
</style>
</head>
<body>
<main>
  <header>
    ${inlineLockup(parts.lockupSvg)}
    <h1 class="fab-title">FABRICO EXAMPLES</h1>
    <p>${escapeHtml(INTRO)}</p>
  </header>
  <nav id="${BOARD_LIST_ID}" aria-labelledby="${BOARD_LIST_ID}-heading">
    <h2 class="fab-title" id="${BOARD_LIST_ID}-heading">BOARDS</h2>
    <ul>
${links}
    </ul>
  </nav>
${sections}
</main>
${BUNDLE_MARKER}
</body>
</html>
`;
  return buildPage(template, parts.bundle, 'fabrico-examples.html');
}

/**
 * Text the shipped file must not hold: a source-map reference, the home folder or the repo's
 * absolute path. Returns what it found, or an empty list.
 */
export function leaks(page: string, home: string = os.homedir(), repo: string = REPO): string[] {
  const out: string[] = [];
  if (page.includes('sourceMappingURL')) out.push('a sourceMappingURL comment');
  if (home !== '' && home !== '/' && page.includes(home)) out.push(`the home folder path ${home}`);
  if (page.includes(repo)) out.push(`the repo path ${repo}`);
  return out;
}

/** Load a TypeScript module through Vite's module runner, rooted at the frontend folder. */
async function load<T>(rel: string): Promise<T> {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport<T>(path.join(FRONTEND, rel), {
    configFile: false,
    root: FRONTEND,
    logLevel: 'silent',
  });
  return module;
}

type PlayerWasm = typeof import('../src/player/playerWasm.ts');
type SkinCss = typeof import('../src/render/synth/chrome/skinToCssVars.ts');
type Locked = typeof import('../src/render/synth/skins/locked.ts');
type EmbedStyles = typeof import('../src/embed/styles.ts');

/** Build the offline file from the bundle, the boards and the player module at `wasmPath`. */
async function buildExamples(wasmPath: string): Promise<{ bytes: number; boards: number }> {
  const [playerWasm, skinCss, locked, styles] = await Promise.all([
    load<PlayerWasm>('src/player/playerWasm.ts'),
    load<SkinCss>('src/render/synth/chrome/skinToCssVars.ts'),
    load<Locked>('src/render/synth/skins/locked.ts'),
    load<EmbedStyles>('src/embed/styles.ts'),
  ]);
  const player = await playerWasm.loadPlayerModule(fs.readFileSync(wasmPath));
  const boards: ExampleBoard[] = exampleBoardFiles().map(({ id, path: rel }) => {
    const board = player.createBoard(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    try {
      return { id, path: rel, title: board.boardInfo().title };
    } finally {
      board.destroy();
    }
  });
  const page = examplesPage({
    boards,
    bundle: fs.readFileSync(BUNDLE_PATH, 'utf8'),
    fontCss: styles.FONT_FACE_CSS,
    tokenCss: skinCss.skinToCssVars(locked.LOCKED_SKIN, 1, ':root'),
    lockupSvg: fs.readFileSync(LOCKUP_PATH, 'utf8'),
  });
  const found = leaks(page);
  if (found.length > 0) throw new Error(`build-offline: the offline file would carry ${found.join(', ')}`);
  fs.mkdirSync(path.dirname(EXAMPLES_FILE), { recursive: true });
  fs.writeFileSync(EXAMPLES_FILE, page);
  return { bytes: Buffer.byteLength(page), boards: boards.length };
}

/**
 * Is this file the script Node was asked to run, rather than a module another script imported?
 * `import.meta.main` answers that on Node 24; on a Node without it, compare the script path.
 */
function isMain(): boolean {
  const main = (import.meta as ImportMeta & { main?: boolean }).main;
  if (typeof main === 'boolean') return main;
  const script = process.argv[1];
  return script !== undefined && path.resolve(script) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const wasm = process.env.FABRICO_PLAYER_WASM;
    if (wasm === undefined || wasm === '' || !fs.existsSync(wasm) || fs.statSync(wasm).size === 0) {
      console.error(`build-offline: FABRICO_PLAYER_WASM must name the built player module (it is ${wasm ?? 'unset'})`);
      process.exit(2);
    }
    await buildExamples(wasm);
  } else {
    const [mode, templatesDir, outDir] = args;
    if (mode !== '--pages' || templatesDir === undefined || outDir === undefined || args.length !== 3) {
      console.error('usage: node scripts/build-offline.ts [--pages <templates-dir> <out-dir>]');
      process.exit(2);
    }
    buildPages(templatesDir, outDir);
  }
}
