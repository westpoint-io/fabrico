// The read-only board's styles. Each board renders into an open shadow root with this stylesheet,
// so the page's CSS can't restyle its controls and its CSS can't leak into the page.
//
// The tokens are the app's (`skinToCssVars` under `:host`), the control rules are the app's
// (`controlCss.ts`), and the layout rules below use only `--fab-*` tokens. Breakpoints are on the
// element's own width, through a container on the host, never on the viewport: a board sits in a
// docs column whose width has little to do with the window's.
//
// FONTS GO IN THE DOCUMENT HEAD. An `@font-face` rule only inside a shadow root's stylesheet
// doesn't load in Chromium or Firefox, so the first board to connect adds one
// `<style data-fabrico-fonts>` to `document.head` with both faces inlined as `data:` URLs, at the
// weight ranges the app's stylesheet declares.

import MARTIAN_MONO_URL from '../assets/fonts/MartianMono.woff2?inline';
import SONO_URL from '../assets/fonts/Sono.woff2?inline';
import {
  FIELD_CSS,
  HINT_CSS,
  PANEL_CSS,
  TOOL_BTN_CSS,
  VISUALLY_HIDDEN_CSS,
} from '../render/synth/chrome/controlCss';
import { skinToCssVars } from '../render/synth/chrome/skinToCssVars';
import { LOCKED_SKIN } from '../render/synth/skins/locked';

/** The stage's shape: 16:10, clamped to this height range, in CSS px. */
export const STAGE_MIN_PX = 240;
export const STAGE_MAX_PX = 560;

/** The element's own layout rules. Tokens only. */
export const LAYOUT_CSS = `
:host {
  display: block;
  container-type: inline-size;
}
:host([hidden]) { display: none; }
.frame {
  display: flex;
  flex-direction: column;
  gap: var(--fab-space-sm);
  padding: calc(var(--fab-space-sm) + var(--fab-bezel-ring));
}
.stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 10;
  min-height: ${STAGE_MIN_PX}px;
  max-height: ${STAGE_MAX_PX}px;
  overflow: hidden;
  background-color: var(--fab-substrate);
}
.stage > canvas {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
}
.status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--fab-space-lg);
  box-sizing: border-box;
  pointer-events: none;
}
.status[hidden] { display: none; }
.loading {
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  color: var(--fab-ink);
}
.card {
  box-sizing: border-box;
  max-width: 420px;
  width: 100%;
  padding: var(--fab-space-lg);
  background-color: var(--fab-substrate);
  border: 1px solid var(--fab-edge-lit);
  color: var(--fab-ink);
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1.4;
  pointer-events: auto;
}
.card-heading {
  display: flex;
  align-items: center;
  gap: var(--fab-space-sm);
  margin: 0 0 var(--fab-space-sm);
  font-size: var(--fab-font-size-base);
  line-height: 1;
}
.card-heading svg { color: var(--fab-destructive); flex: none; }
.card-body { margin: 0; overflow-wrap: anywhere; }

/* The label overlay: name chips and label words over the canvas, clipped by the stage. */
.labels {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.chip {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  white-space: nowrap;
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  color: var(--fab-ink);
  padding: var(--fab-space-xs);
  background-color: color-mix(in srgb, var(--fab-substrate) 85%, transparent);
  border: 1px solid var(--fab-outline);
  will-change: transform;
}
.words {
  position: absolute;
  top: 0;
  left: 0;
  visibility: hidden;
  transform-origin: 0 0;
  overflow: hidden;
  font-family: var(--fab-font);
  font-size: 12px;
  line-height: 16px;
  color: var(--fab-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  will-change: transform;
}

/* The caption ring: the app's .fab-hint look, placed by captions.ts in stage px. */
.caption-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.caption-ring {
  position: absolute;
  top: 0;
  left: 0;
}
.caption-ring[hidden] { display: none; }

/* The caption strip, under the stage. The 3 px rail shows while a caption holds the board. The
   minimum height fits the heading and two lines of text, so the rows below don't jump at each note. */
.captions {
  box-sizing: border-box;
  min-height: calc(var(--fab-font-size-base) + var(--fab-space-xs) + 2 * 1.4 * var(--fab-font-size-base) + 2 * var(--fab-space-xs));
  padding: var(--fab-space-xs) var(--fab-space-sm) var(--fab-space-xs) calc(var(--fab-space-sm) + 3px);
  box-shadow: inset 3px 0 0 transparent;
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1.4;
  color: var(--fab-ink);
}
.captions[hidden] { display: none; }
.captions.is-holding { box-shadow: inset 3px 0 0 var(--fab-focus); }
.captions p { margin: 0; overflow-wrap: anywhere; }
.captions .caption-heading {
  font-family: var(--fab-font-title);
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  line-height: 1;
  margin-bottom: var(--fab-space-xs);
}

/* The control bar: the transport group (restart, play, step, counter) and the readout group
   (speed, hash badge). 8 px between controls, 16 px between groups.

   It is one row when the element is wide enough to hold both groups and wraps when it isn't, so
   the breakpoint follows the board: one row takes about 704 px for a board whose end tick has 4
   digits and less for a shorter one. Wrapped, row 1 holds restart, play, step and the counter,
   and row 2 the speed and the badge. The readout group wraps too, so on a phone-width column the
   badge takes a third row rather than spilling past the frame. */
.bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  column-gap: var(--fab-space-md);
  row-gap: var(--fab-space-sm);
}
.group {
  display: flex;
  align-items: center;
  gap: var(--fab-space-sm);
  flex: none;
  max-width: 100%;
}
.group.readout { flex-wrap: wrap; }
/* The app's header reclaim: an icon button measures 44 by 44. */
.bar .fab-tool-btn {
  padding: var(--fab-bezel-ring) calc(var(--fab-space-sm) + var(--fab-bezel-ring));
}
.bar .fab-tool-btn svg { flex: none; }
.counter {
  display: inline-block;
  box-sizing: content-box;
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  font-family: var(--fab-font);
  font-size: var(--fab-font-size-base);
  line-height: 1;
  color: var(--fab-ink);
}
.speed-label {
  display: inline-flex;
  align-items: center;
  gap: var(--fab-space-sm);
  line-height: 1;
}
.speed-label .fab-field {
  height: var(--fab-min-target);
  box-sizing: border-box;
}
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--fab-space-xs);
  box-sizing: border-box;
  min-height: var(--fab-min-target);
  padding: 0 var(--fab-space-sm);
  background-color: var(--fab-substrate);
  border: 1px solid var(--fab-edge-lit);
  color: var(--fab-ink);
  white-space: nowrap;
  line-height: 1;
}
.badge-glyph { color: var(--fab-destructive); flex: none; }
.badge.is-failure .badge-verdict { color: var(--fab-destructive); }
.badge-verdict { white-space: pre; }
`;

/** The whole stylesheet for one board's shadow root. */
export function boardStylesheet(dpr: number): string {
  return [
    skinToCssVars(LOCKED_SKIN, dpr, ':host'),
    PANEL_CSS,
    HINT_CSS,
    TOOL_BTN_CSS,
    FIELD_CSS,
    VISUALLY_HIDDEN_CSS,
    LAYOUT_CSS,
  ].join('\n');
}

/** The two faces, at the same weight ranges as the app's stylesheet. */
export const FONT_FACE_CSS = `@font-face {
  font-family: 'Martian Mono';
  src: url(${MARTIAN_MONO_URL}) format('woff2');
  font-weight: 100 800;
  font-style: normal;
  font-display: block;
}
@font-face {
  font-family: 'Sono';
  src: url(${SONO_URL}) format('woff2');
  font-weight: 200 800;
  font-style: normal;
  font-display: block;
}`;

/** Add the font faces to the document head, once per page. */
export function injectFonts(doc: Document = document): void {
  if (doc.head.querySelector('style[data-fabrico-fonts]') !== null) return;
  const style = doc.createElement('style');
  style.setAttribute('data-fabrico-fonts', '');
  style.textContent = FONT_FACE_CSS;
  doc.head.append(style);
}
