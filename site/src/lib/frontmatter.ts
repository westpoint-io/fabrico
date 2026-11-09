// The description rule for docs pages. The content schema in src/content.config.ts runs every
// page's `description` through descriptionError, so a page with a missing, short or long
// description fails `astro build`. Astro names the page in front of the message itself.
//
// This file imports nothing from Astro, so the unit tests run it under plain Node.

/** The shortest description a page may have, in characters. */
export const DESCRIPTION_MIN = 50;

/** The longest description a page may have, in characters. Search results cut longer ones. */
export const DESCRIPTION_MAX = 160;

/**
 * Null when `value` is a description of DESCRIPTION_MIN to DESCRIPTION_MAX characters, else the
 * message the build prints. Characters are Unicode code points, so an accented letter or an emoji
 * counts once whatever its UTF-16 length.
 */
export function descriptionError(value: string | undefined): string | null {
  const count = value === undefined ? undefined : [...value].length;
  if (count !== undefined && count >= DESCRIPTION_MIN && count <= DESCRIPTION_MAX) return null;
  return (
    `This page needs a description of ${String(DESCRIPTION_MIN)} to ${String(DESCRIPTION_MAX)} characters ` +
    `in its frontmatter. It has ${count === undefined ? 'none' : String(count)}.`
  );
}
