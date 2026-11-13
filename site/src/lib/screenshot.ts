// The rules a page's <Screenshot> goes through while the site builds. Each broken rule throws with
// the message an author sees in the build log, naming the page or the file and the fix, so a tour
// page can't ship a missing picture, a picture without alt text, or one not taken at twice the
// screen size.
//
// No Astro import here: the unit tests load this file with plain Node.

/** Where the tour pictures live, as the build messages name it. */
export const TOUR_DIR = 'site/src/assets/tour/';

/**
 * The widest the page column gets, in CSS px. A picture shown wider than this is scaled down to
 * fit, so its caption links the full file.
 */
export const COLUMN_MAX_CSS = 768;

/** The picture names for a list of glob keys or paths of tour PNGs, sorted. */
export function tourNamesOf(paths: readonly string[]): string[] {
  const names: string[] = [];
  for (const p of paths) {
    const m = /([^/]+)\.png$/.exec(p);
    if (m !== null) names.push(m[1]);
  }
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The picture a page names, or a thrown Error naming the page, the name and the known pictures. */
export function resolveShot(name: string | undefined, page: string, known: readonly string[]): string {
  if (name === undefined || name === '') {
    throw new Error(
      `[Screenshot] ${page} has a <Screenshot> with no name. Give it a picture name, for example <Screenshot name="palette" />.`,
    );
  }
  if (known.includes(name)) return name;
  throw new Error(
    `[Screenshot] ${page} names picture "${name}", and ${TOUR_DIR} has no ${name}.png. ` +
      `Known pictures: ${known.join(', ')}. Run npm run capture:tour from frontend/ to take them again.`,
  );
}

/** Alt and caption are both given, and they differ. */
export function checkAltAndCaption(page: string, name: string, alt: string | undefined, caption: string | undefined): void {
  for (const [prop, value] of [
    ['alt', alt],
    ['caption', caption],
  ] as const) {
    if (value === undefined || value.trim() === '') {
      throw new Error(
        `[Screenshot] ${page} has a <Screenshot name="${name}"> with no ${prop}. ` +
          'Give it one: alt says what the picture shows, caption says what to notice.',
      );
    }
  }
  if ((alt as string).trim() === (caption as string).trim()) {
    throw new Error(
      `[Screenshot] ${page} gives picture "${name}" the same alt and caption. ` +
        'A screen reader reads both, so make alt describe the picture and caption say what to notice.',
    );
  }
}

/** Both sides of a tour picture are even, since it was taken at twice the screen size. */
export function checkEvenSize(name: string, width: number, height: number): void {
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(
      `[Screenshot] ${TOUR_DIR}${name}.png is ${width} x ${height} pixels. ` +
        'Tour pictures are taken at twice the screen size, so both sides must be even. Take it again with npm run capture:tour.',
    );
  }
}

/** Whether a picture shown at this CSS width gets an Open full size link: wider than the column. */
export function opensFullSize(cssWidth: number): boolean {
  return cssWidth > COLUMN_MAX_CSS;
}
