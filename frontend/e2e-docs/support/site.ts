// Shared helpers for the docs suite. The suite runs over the built site that scripts/check-docs.sh
// serves, at the URL it exports as FABRICO_DOCS_URL (ending in /fabrico/).
//
// Nothing here imports a file under site/: a docs-only change doesn't run the frontend's type
// check, so the suite must not depend on site/ source at compile time. Anything it needs from
// site/ it reads at run time, over HTTP from the served build or from disk with fs.

/** The address the site is published at. Its sitemaps list pages under this prefix. */
export const PUBLISHED_ROOT = 'https://westpoint-io.github.io/fabrico/';

/** The served site's root, `http://127.0.0.1:<port>/fabrico/`. Throws when the variable is unset. */
export function docsRoot(): string {
  const root = process.env.FABRICO_DOCS_URL;
  if (root === undefined || root === '') {
    throw new Error('FABRICO_DOCS_URL is unset. Run the docs suite through scripts/check-docs.sh.');
  }
  return root.endsWith('/') ? root : `${root}/`;
}

/** A page or file of the served site, by its path under /fabrico/ (`get-started/`, `sitemap-index.xml`). */
export function docsUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), docsRoot()).href;
}

/** A published URL from a sitemap, moved onto the local server. */
export function toLocal(published: string): string {
  if (!published.startsWith(PUBLISHED_ROOT)) {
    throw new Error(`the sitemap lists ${published}, which is outside ${PUBLISHED_ROOT}`);
  }
  return docsUrl(published.slice(PUBLISHED_ROOT.length));
}

/** The text of a served file. Throws on any status but 200. */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (response.status !== 200) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** Every `<loc>` in a sitemap file, in file order. */
export function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * Every page the site's sitemap lists, as local URLs, sorted. Reads sitemap-index.xml, then each
 * sitemap it names.
 */
export async function sitemapPages(): Promise<string[]> {
  const pages: string[] = [];
  for (const sitemap of locsOf(await fetchText(docsUrl('sitemap-index.xml')))) {
    for (const page of locsOf(await fetchText(toLocal(sitemap)))) pages.push(toLocal(page));
  }
  return pages.sort();
}

/** The `name` of every `<fabrico-board>` in a page's HTML, in page order. */
export function boardNames(html: string): string[] {
  return [...html.matchAll(/<fabrico-board\b[^>]*?\sname="([^"]*)"/g)].map((m) => m[1]);
}
