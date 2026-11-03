// The error cards a read-only board shows inside its stage: a board name the bundle doesn't know,
// a board file in an old format, a board file the player refused for another reason, and an
// engine that stopped mid-run. The stage keeps its size behind every card.
//
// Every word is set with `textContent`. A board's name comes from the page and a player error can
// quote the board file, and both are untrusted text on a docs page.

import WARNING_SVG from '../chrome/assets/warning.svg?raw';
import { formatTick, glyph } from './controls';

/** Which card a player error maps to. */
export type PlayerErrorKind =
  | { kind: 'old-format'; format: number }
  | { kind: 'engine-stopped' }
  | { kind: 'load-failed' };

/** A card's two lines. */
export interface ErrorCopy {
  heading: string;
  body: string;
}

const TRAPPED_TEXT = 'the player instance trapped';
const FORMAT_TEXT = /has format (\d+)/;

/**
 * Map the player's error text to a card. The Rust text "has format N" is the old-format card at
 * any point. A trapped player is the engine stopping, wherever it happened. Anything else from
 * `step` is the engine stopping, and anything else from create is a board that didn't load.
 */
export function classifyPlayerError(message: string, phase: 'create' | 'step'): PlayerErrorKind {
  const format = FORMAT_TEXT.exec(message);
  if (format !== null) return { kind: 'old-format', format: Number(format[1]) };
  if (message.includes(TRAPPED_TEXT) || phase === 'step') return { kind: 'engine-stopped' };
  return { kind: 'load-failed' };
}

/** The card for a name the bundle has no board for. */
export function unknownBoardCopy(name: string): ErrorCopy {
  return {
    heading: 'BOARD DID NOT LOAD',
    body: `There's no board named "${name}" in this bundle. Check the name attribute against the files in examples/boards/.`,
  };
}

/** The card for a classified player error, with the player's text and the tick it stopped on. */
export function errorCopy(error: PlayerErrorKind, at: { message: string; tick: number }): ErrorCopy {
  switch (error.kind) {
    case 'old-format':
      return {
        heading: 'BOARD DID NOT LOAD',
        body: `This board file is format ${error.format}, and this player reads format 2. Update the file to format 2 and give it a captions list.`,
      };
    case 'engine-stopped':
      return {
        heading: 'ENGINE STOPPED',
        body: `The engine stopped at tick ${formatTick(at.tick)}: ${at.message}. Press Restart to run it again. If it stops at the same tick, report it with this board's name.`,
      };
    case 'load-failed':
      return {
        heading: 'BOARD DID NOT LOAD',
        body: `The player refused this board file: ${at.message}.`,
      };
  }
}

/** The card element: the warning glyph and the heading on one line, then the body. */
export function buildErrorCard(copy: ErrorCopy): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'alert');
  const heading = document.createElement('p');
  heading.className = 'card-heading fab-title';
  const words = document.createElement('span');
  words.textContent = copy.heading;
  heading.append(glyph(WARNING_SVG), words);
  const body = document.createElement('p');
  body.className = 'card-body';
  body.textContent = copy.body;
  card.append(heading, body);
  return card;
}
