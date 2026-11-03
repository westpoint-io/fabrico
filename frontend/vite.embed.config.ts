// The read-only board bundle: one IIFE file, `dist-embed/fabrico-board.js`, that defines
// `<fabrico-board>` and carries everything a page needs to run the example boards with no network.
// The player module, every `*.board.ron` under `examples/boards/` and the hash manifest are inlined
// through `virtual:fabrico-embed-data`. Build it with `scripts/build-embed.sh`, which supplies the
// player module's path.
//
// No React plugin and no source map: the bundle is the renderer, the player loader and the element,
// and a map would carry absolute build paths and the sources.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const FRONTEND = fileURLToPath(new URL('.', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const BOARDS_DIR = path.join(REPO, 'examples', 'boards');

const VIRTUAL_ID = 'virtual:fabrico-embed-data';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

/** Every `*.board.ron` under `dir`, at any depth, as repo-relative `/`-separated paths. */
function boardFiles(dir: string, relative: string, found: string[]): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const child = `${relative}/${name}`;
    if (fs.statSync(full).isDirectory()) {
      boardFiles(full, child, found);
    } else if (name.endsWith('.board.ron')) {
      found.push(child);
    }
  }
}

/** `examples/boards/docs/script-outcomes.board.ron` to `docs-script-outcomes`. */
function boardId(repoPath: string): string {
  return repoPath.slice('examples/boards/'.length, -'.board.ron'.length).replace(/\//g, '-');
}

function embedDataPlugin(): Plugin {
  return {
    name: 'fab-embed-data',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const wasmPath = process.env.FABRICO_PLAYER_WASM;
      if (wasmPath === undefined || wasmPath === '') {
        throw new Error('fab-embed-data: FABRICO_PLAYER_WASM is unset. Build the bundle with scripts/build-embed.sh.');
      }
      if (!fs.existsSync(wasmPath) || fs.statSync(wasmPath).size === 0) {
        throw new Error(
          `fab-embed-data: ${wasmPath} is missing or empty. Build the player, then run scripts/build-embed.sh.`,
        );
      }
      const paths: string[] = [];
      boardFiles(BOARDS_DIR, 'examples/boards', paths);
      // Byte-wise path order, the order hashes.manifest uses.
      paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const boards = paths.map((p) => ({
        id: boardId(p),
        path: p,
        text: fs.readFileSync(path.join(REPO, p), 'utf8'),
      }));
      const manifest = fs.readFileSync(path.join(BOARDS_DIR, 'hashes.manifest'), 'utf8');
      const wasm = fs.readFileSync(wasmPath).toString('base64');
      return [
        `export const PLAYER_WASM_BASE64 = ${JSON.stringify(wasm)};`,
        `export const BOARDS = ${JSON.stringify(boards)};`,
        `export const MANIFEST_TEXT = ${JSON.stringify(manifest)};`,
      ].join('\n');
    },
  };
}

export default defineConfig({
  plugins: [embedDataPlugin()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: 'src/embed/index.ts',
      name: 'FabricoEmbed',
      formats: ['iife'],
      fileName: () => 'fabrico-board.js',
    },
  },
});
