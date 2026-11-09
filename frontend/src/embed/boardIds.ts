// The board id rule and the poster alt rule, with no imports, so plain Node can load this file
// (the docs site's build reads both). `registry.ts` re-exports them for the embed itself.

const BOARDS_PREFIX = 'examples/boards/';
const BOARD_SUFFIX = '.board.ron';

/** `examples/boards/docs/script-outcomes.board.ron` to `docs-script-outcomes`. */
export function boardIdOf(path: string): string | null {
  if (!path.startsWith(BOARDS_PREFIX) || !path.endsWith(BOARD_SUFFIX)) return null;
  return path.slice(BOARDS_PREFIX.length, -BOARD_SUFFIX.length).replace(/\//g, '-');
}

/**
 * The poster's alt text: the board's first caption, or `{title}, a Fabrico board, at its last tick`
 * for a board with none. The title falls back to the board's name.
 */
export function posterAlt(info: { title: string; captions: readonly { text: string }[] } | null, name: string): string {
  const first = info?.captions[0]?.text;
  if (first !== undefined && first !== '') return first;
  const title = info === null || info.title === '' ? name : info.title;
  return `${title}, a Fabrico board, at its last tick`;
}
