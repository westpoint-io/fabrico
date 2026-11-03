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
import { refusedModule } from './src/embed/moduleGuard.ts';

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

/**
 * Fails the build when the bundle would carry a module `refusedModule` refuses.
 *
 * It reads `chunk.modules` in `generateBundle`, the modules actually rendered into each chunk. The
 * source map misses `?raw` imports, so a raw import of a chrome file would pass a map-based check,
 * and the whole module graph includes code that tree-shaking dropped. Ids are cleaned the way
 * `devFixtureGuardPlugin` in vite.config.ts cleans them: drop a leading NUL and the query, use
 * forward slashes, take the path relative to the frontend root, and skip ids that aren't paths.
 */
function embedGuardPlugin(): Plugin {
  let root = FRONTEND;
  const relOf = (id: string): string | null => {
    const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
    if (!path.isAbsolute(clean)) return null;
    return path.relative(root, clean).replace(/\\/g, '/');
  };
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
          const rel = relOf(id);
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
