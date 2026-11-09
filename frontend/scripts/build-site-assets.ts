// build-site-assets.ts - copies what the docs site needs from the embed build into site/.
//
// The docs site (site/, an Astro project) embeds boards with the same bundle the embed build makes,
// so nothing under site/ holds a copy of the player or the renderer as source. Before each site
// build this script:
//
//   - copies frontend/dist-embed/fabrico-board.js to site/public/embed/fabrico-board.js;
//   - copies each board's poster, frontend/dist-embed/posters/<id>.png, to site/public/boards/<id>.png;
//   - writes site/src/generated/boards.json, `{ "boards": [ { id, path, title, posterAlt } ] }`
//     sorted by id, which the site's <Board> component reads for each poster's alt text.
//
// Titles and captions come from the player itself: the script loads the player module named by
// FABRICO_PLAYER_WASM in Node and asks each board for its info, the way build-offline.ts does. The
// alt text comes from the embed's own rule in src/embed/boardIds.ts. All three outputs are
// gitignored. It copies named files only, never a whole folder.
//
// OUTPUT, exactly one line on stdout:
//   SITE_ASSETS boards=<n> posters=<n> bundle=<bytes>
//
// ENVIRONMENT
//   FABRICO_PLAYER_WASM  the built player module (scripts/build-wasm.sh writes it).
//
// EXIT CODES
//   0  the files were copied and written, and the line was printed.
//   2  nothing written: the bundle or a board's poster is missing (run scripts/build-embed.sh), or
//      FABRICO_PLAYER_WASM doesn't name a readable module.
//   Any other non-zero code is a thrown error (a board the player refuses, for example).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleBoardFiles } from './build-offline.ts';
import { posterAlt } from '../src/embed/boardIds.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const SITE = path.join(REPO, 'site');
const BUNDLE = path.join(FRONTEND, 'dist-embed', 'fabrico-board.js');
const POSTERS = path.join(FRONTEND, 'dist-embed', 'posters');

/** One board's line in boards.json. */
export interface SiteBoard {
  id: string;
  path: string;
  title: string;
  posterAlt: string;
}

function refuse(message: string): never {
  console.error(`build-site-assets: ${message}`);
  process.exit(2);
}

type PlayerWasm = typeof import('../src/player/playerWasm.ts');

/** Load the player loader through Vite's module runner; plain Node can't strip it. */
async function loadPlayerWasm(): Promise<PlayerWasm> {
  const { runnerImport } = await import('vite');
  const { module } = await runnerImport<PlayerWasm>(path.join(FRONTEND, 'src/player/playerWasm.ts'), {
    configFile: false,
    root: FRONTEND,
    logLevel: 'silent',
  });
  return module;
}

const wasm = process.env.FABRICO_PLAYER_WASM;
if (wasm === undefined || wasm === '') refuse('FABRICO_PLAYER_WASM is unset. Build the site with scripts/build-site.sh.');
let wasmBytes: Buffer<ArrayBuffer>;
try {
  wasmBytes = fs.readFileSync(wasm);
} catch {
  refuse(`FABRICO_PLAYER_WASM names ${wasm}, which can't be read. Run scripts/build-wasm.sh.`);
}
if (wasmBytes.length === 0) refuse(`FABRICO_PLAYER_WASM names ${wasm}, which is empty. Run scripts/build-wasm.sh.`);

if (!fs.existsSync(BUNDLE)) refuse(`${path.relative(REPO, BUNDLE)} is missing. Run scripts/build-embed.sh.`);
const files = exampleBoardFiles();
const missing = files.filter((b) => !fs.existsSync(path.join(POSTERS, `${b.id}.png`))).map((b) => b.path);
if (missing.length > 0) {
  refuse(`no poster for ${missing.join(', ')} in ${path.relative(REPO, POSTERS)}/. Run scripts/build-embed.sh.`);
}

const playerWasm = await loadPlayerWasm();
const player = await playerWasm.loadPlayerModule(wasmBytes);
const boards: SiteBoard[] = files.map(({ id, path: rel }) => {
  const board = player.createBoard(fs.readFileSync(path.join(REPO, rel), 'utf8'), { order: 'forward' });
  try {
    const info = board.boardInfo();
    return { id, path: rel, title: info.title, posterAlt: posterAlt(info, id) };
  } finally {
    board.destroy();
  }
});
boards.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const embedDir = path.join(SITE, 'public', 'embed');
const boardsDir = path.join(SITE, 'public', 'boards');
const generatedDir = path.join(SITE, 'src', 'generated');
// Start each folder empty, so a board removed from examples/boards/ leaves no stale poster.
fs.rmSync(boardsDir, { recursive: true, force: true });
for (const dir of [embedDir, boardsDir, generatedDir]) fs.mkdirSync(dir, { recursive: true });

fs.copyFileSync(BUNDLE, path.join(embedDir, 'fabrico-board.js'));
for (const b of boards) fs.copyFileSync(path.join(POSTERS, `${b.id}.png`), path.join(boardsDir, `${b.id}.png`));
fs.writeFileSync(path.join(generatedDir, 'boards.json'), `${JSON.stringify({ boards }, null, 2)}\n`);

console.log(`SITE_ASSETS boards=${boards.length} posters=${boards.length} bundle=${fs.statSync(BUNDLE).size}`);
