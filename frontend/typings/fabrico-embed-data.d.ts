// AMBIENT TYPES for `virtual:fabrico-embed-data`, the module `vite.embed.config.ts` builds at
// bundle time. The embed reads every board, the hash manifest and the player module from it, so
// a page that runs a board needs no fetch at all. It has no file on disk, so without this
// declaration every import of it is a TS2307 error.
declare module 'virtual:fabrico-embed-data' {
  /** The player module's bytes as base64, decoded with `atob` (never fetched, not even as a data: URL). */
  export const PLAYER_WASM_BASE64: string;
  /**
   * Every `*.board.ron` under `examples/boards/`, sorted by path. `id` is the path under
   * `examples/boards/` without `.board.ron`, with `/` turned into `-` (`docs-script-outcomes`);
   * `path` is repo-relative (`examples/boards/docs/script-outcomes.board.ron`).
   */
  export const BOARDS: readonly { id: string; path: string; text: string }[];
  /** The text of `examples/boards/hashes.manifest`. */
  export const MANIFEST_TEXT: string;
  /**
   * Each bundled board's info, keyed by board id, as the player reported it at build time. A board
   * the player refused has no entry.
   */
  export const BOARD_INFO: Readonly<Record<string, import('../src/player/playerWasm').BoardInfo>>;
}
