// What the bundle carries: every example board's text, the hash manifest and the player module,
// all inlined at build time by `vite.embed.config.ts`. Nothing here fetches.

import { BOARDS, MANIFEST_TEXT, PLAYER_WASM_BASE64 } from 'virtual:fabrico-embed-data';
import { compilePlayer } from '../player/playerWasm';

/** A board's line in `hashes.manifest`: the tick it ends on and its state hash there. */
export interface ManifestEntry {
  endTick: number;
  hash: string;
}

const BOARDS_PREFIX = 'examples/boards/';
const BOARD_SUFFIX = '.board.ron';

/** `examples/boards/docs/script-outcomes.board.ron` to `docs-script-outcomes`. */
export function boardIdOf(path: string): string | null {
  if (!path.startsWith(BOARDS_PREFIX) || !path.endsWith(BOARD_SUFFIX)) return null;
  return path.slice(BOARDS_PREFIX.length, -BOARD_SUFFIX.length).replace(/\//g, '-');
}

/** Every board id the bundle carries, in path order. */
export function boardIds(): string[] {
  return BOARDS.map((b) => b.id);
}

/** A board's file text, or null when the bundle has no board by that id. */
export function boardText(id: string): string | null {
  return BOARDS.find((b) => b.id === id)?.text ?? null;
}

let manifest: Map<string, ManifestEntry> | null = null;

/** Parse the manifest text: `<path> <end tick> <hash>` per line, `#` lines skipped. */
export function parseManifest(text: string): Map<string, ManifestEntry> {
  const out = new Map<string, ManifestEntry>();
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const fields = line.split(' ');
    if (fields.length !== 3) continue;
    const [path, endTick, hash] = fields;
    const id = boardIdOf(path);
    if (id === null || !/^\d+$/.test(endTick) || !/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!out.has(id)) out.set(id, { endTick: Number(endTick), hash });
  }
  return out;
}

/** The manifest line for a board id, or null when the manifest doesn't pin it. */
export function manifestEntry(id: string): ManifestEntry | null {
  manifest ??= parseManifest(MANIFEST_TEXT);
  return manifest.get(id) ?? null;
}

let compiled: Promise<WebAssembly.Module> | null = null;

/** The player module, compiled once per page from the inlined bytes. */
export function compiledPlayer(): Promise<WebAssembly.Module> {
  if (compiled === null) {
    const bin = atob(PLAYER_WASM_BASE64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    compiled = compilePlayer(bytes);
  }
  return compiled;
}
