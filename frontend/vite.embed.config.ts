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
import { moduleRel, refusedModule } from './src/embed/moduleGuard.ts';
import { loadPlayerModule, type BoardInfo } from './src/player/playerWasm.ts';

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

/**
 * Each bundled board's info (title, captions, Factory and Handler sources), read by running the
 * player itself on the board text at build time. A page uses it to lay a board out before its
 * player has loaded, so the code column and the caption strip are there from the first frame and
 * the stage doesn't narrow when the board finishes loading. A board the player refuses gets no
 * entry; the page then shows the player's own error when it loads.
 */
async function buildBoardInfo(wasm: Uint8Array<ArrayBuffer>, boards: readonly { id: string; text: string }[]): Promise<Record<string, BoardInfo>> {
  const player = await loadPlayerModule(wasm);
  const out: Record<string, BoardInfo> = {};
  for (const { id, text } of boards) {
    let board;
    try {
      board = player.createBoard(text, { order: 'forward' });
    } catch {
      continue;
    }
    out[id] = board.boardInfo();
    board.destroy();
  }
  return out;
}

function embedDataPlugin(): Plugin {
  return {
    name: 'fab-embed-data',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
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
      const wasmBytes = fs.readFileSync(wasmPath);
      const wasm = wasmBytes.toString('base64');
      const info = await buildBoardInfo(Uint8Array.from(wasmBytes), boards);
      return [
        `export const PLAYER_WASM_BASE64 = ${JSON.stringify(wasm)};`,
        `export const BOARDS = ${JSON.stringify(boards)};`,
        `export const BOARD_INFO = ${JSON.stringify(info)};`,
        `export const MANIFEST_TEXT = ${JSON.stringify(manifest)};`,
      ].join('\n');
    },
  };
}

/**
 * Fails the build when the bundle would carry a module `refusedModule` refuses.
 *
 * It reads `chunk.modules` in `generateBundle`, the modules actually rendered into each chunk. The
 * source map misses `?raw` imports, so a raw import of a chrome file would pass a map-based check,
 * and the whole module graph includes code that tree-shaking dropped. `moduleRel` cleans each id
 * the way `devFixtureGuardPlugin` in vite.config.ts does (drop a leading NUL and the query, forward
 * slashes, relative to the frontend root, skip ids that aren't paths), and names package files
 * from their last `node_modules/` segment so a linked `node_modules` can't hide one.
 */
function embedGuardPlugin(): Plugin {
  let root = FRONTEND;
  return {
    name: 'fab-embed-guard',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const refused = new Set<string>();
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of Object.keys(chunk.modules)) {
          const rel = moduleRel(id, root);
          if (rel === null) continue;
          const reason = refusedModule(rel);
          if (reason !== null) refused.add(reason);
        }
      }
      if (refused.size > 0) {
        throw new Error(
          `fab-embed-guard: the read-only board bundle may not carry these modules:\n  ${[...refused].sort().join('\n  ')}`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [embedDataPlugin(), embedGuardPlugin()],
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
