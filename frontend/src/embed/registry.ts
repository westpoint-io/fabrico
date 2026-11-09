// What the bundle carries: every example board's text, the hash manifest and the player module,
// all inlined at build time by `vite.embed.config.ts`. Nothing here fetches.
//
// A page can add a board the bundle doesn't carry with `registerBoard(id, text)` (exposed as
// `window.FabricoEmbed.registerBoard`). A registered board has no manifest line, so its badge reads
// "not pinned", and it can't take a bundled board's id, so it can't borrow that board's pin.

import { BOARD_INFO, BOARDS, MANIFEST_TEXT, PLAYER_WASM_BASE64, POSTERS } from 'virtual:fabrico-embed-data';
import { compilePlayer, type BoardInfo } from '../player/playerWasm';
import { boardIdOf } from './boardIds';

export { boardIdOf, posterAlt } from './boardIds';

/** A board's line in `hashes.manifest`: the tick it ends on and its state hash there. */
export interface ManifestEntry {
  endTick: number;
  hash: string;
}

/** Every board id the bundle carries, in path order. */
export function boardIds(): string[] {
  return BOARDS.map((b) => b.id);
}

const registered = new Map<string, string>();
const registeredListeners = new Set<(id: string) => void>();

/** A board's file text, bundled or registered, or null when there is no board by that id. */
export function boardText(id: string): string | null {
  return BOARDS.find((b) => b.id === id)?.text ?? registered.get(id) ?? null;
}

/**
 * A bundled board's info as the player reported it when the bundle was built, or null for a
 * registered board or an unknown id. The element lays the board out from it before its own player
 * has loaded.
 */
export function bundledInfo(id: string): BoardInfo | null {
  if (!BOARDS.some((b) => b.id === id)) return null;
  return BOARD_INFO[id] ?? null;
}

/**
 * A bundled board's poster, a PNG of its end tick taken from the real renderer when the bundle was
 * built, as a `data:` URL. Null for a registered board, an unknown id, or a bundle built without
 * posters.
 */
export function posterFor(id: string): string | null {
  if (!BOARDS.some((b) => b.id === id)) return null;
  const png = POSTERS[id];
  return png === undefined ? null : `data:image/png;base64,${png}`;
}

/** Was this id added by the page rather than carried by the bundle? */
export function isRegistered(id: string): boolean {
  return registered.has(id);
}

/**
 * Add a board the bundle doesn't carry. Boards already on the page under that name that found no
 * board load it now. Throws a TypeError for an empty id, non-string text, or a bundled id.
 */
export function registerBoard(id: unknown, text: unknown): void {
  if (typeof id !== 'string' || id === '') throw new TypeError('registerBoard: the id is a non-empty string');
  if (typeof text !== 'string') throw new TypeError(`registerBoard: the text of "${id}" is a string`);
  if (BOARDS.some((b) => b.id === id)) {
    throw new TypeError(`registerBoard: "${id}" is a board this bundle carries, so it can't be replaced`);
  }
  registered.set(id, text);
  for (const listener of registeredListeners) listener(id);
}

/** Hear about each board a page registers. Returns the function that stops listening. */
export function onBoardRegistered(listener: (id: string) => void): () => void {
  registeredListeners.add(listener);
  return () => registeredListeners.delete(listener);
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
  if (registered.has(id)) return null;
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
