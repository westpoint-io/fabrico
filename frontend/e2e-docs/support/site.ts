// Shared helpers for the docs suite. The suite runs over the built site that scripts/check-docs.sh
// serves, at the URL it exports as FABRICO_DOCS_URL (ending in /fabrico/), and over the fixture
// build (the same site plus the test pages whose file name starts with _), at FABRICO_DOCS_FIXTURES_URL.
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

/** The served fixture build's root, `http://127.0.0.1:<port>/fabrico/`. Throws when the variable is unset. */
export function fixturesRoot(): string {
  const root = process.env.FABRICO_DOCS_FIXTURES_URL;
  if (root === undefined || root === '') {
    throw new Error('FABRICO_DOCS_FIXTURES_URL is unset. Run the docs suite through scripts/check-docs.sh.');
  }
  return root.endsWith('/') ? root : `${root}/`;
}

/** A page or file of the served site, by its path under /fabrico/ (`get-started/`, `sitemap-index.xml`). */
export function docsUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), docsRoot()).href;
}

/** A page or file of the served fixture build, by its path under /fabrico/. */
export function fixturesUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ''), fixturesRoot()).href;
}

/** A published URL from a sitemap, moved onto the local server (or the fixture server). */
export function toLocal(published: string, root: string = docsRoot()): string {
  if (!published.startsWith(PUBLISHED_ROOT)) {
    throw new Error(`the sitemap lists ${published}, which is outside ${PUBLISHED_ROOT}`);
  }
  return new URL(published.slice(PUBLISHED_ROOT.length), root).href;
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
export async function sitemapPages(root: string = docsRoot()): Promise<string[]> {
  const pages: string[] = [];
  for (const sitemap of locsOf(await fetchText(new URL('sitemap-index.xml', root).href))) {
    for (const page of locsOf(await fetchText(toLocal(sitemap, root)))) pages.push(toLocal(page, root));
  }
  return pages.sort();
}

/**
 * The fixture build's test pages, as local URLs on the fixture server, sorted: the pages its
 * sitemap lists whose path has a part starting with _. Fails when there are none, so a fixture
 * build that skipped its test pages can't pass a check by running nothing.
 */
export async function fixturePages(): Promise<string[]> {
  const root = fixturesRoot();
  const pages = (await sitemapPages(root)).filter((url) => url.slice(root.length).split('/').some((part) => part.startsWith('_')));
  if (pages.length === 0) throw new Error(`the fixture build's sitemap at ${root} lists no test page`);
  return pages;
}

/** The one fixture page whose path holds `name`, such as `_fixture-two-boards`. Throws on none or several. */
export async function fixturePage(name: string): Promise<string> {
  const found = (await fixturePages()).filter((url) => url.includes(`/${name}/`));
  if (found.length !== 1) throw new Error(`the fixture build has ${found.length} pages named ${name}, not 1`);
  return found[0];
}

/** The `name` of every `<fabrico-board>` in a page's HTML, in page order. */
export function boardNames(html: string): string[] {
  return [...html.matchAll(/<fabrico-board\b[^>]*?\sname="([^"]*)"/g)].map((m) => m[1]);
}

/**
 * A path part Astro publishes under its own name. Astro turns each part of a page's path into a
 * slug (lowercase, spaces to hyphens, most punctuation dropped), and a part made only of lowercase
 * letters, digits, hyphens and underscores is already one.
 */
const SLUG_PART = /^[a-z0-9_-]+$/;

/**
 * The built file a source page becomes, by its path under site/src/content/docs/, as a path under
 * the build folder: `get-started/index.mdx` is `get-started/index.html`, `concepts/belts.md` is
 * `concepts/belts/index.html`, and the root `index.mdx` is `index.html`. Throws on a path that
 * isn't a .md or .mdx file, and on a path with a part Astro would rename (`concepts/Belts.md` is
 * published at `concepts/belts/`), so a check never looks for a page under a name it wasn't built at.
 */
export function distFileFor(sourcePath: string): string {
  const match = /^(.*?)\.mdx?$/.exec(sourcePath);
  if (match === null) throw new Error(`${sourcePath} is not a .md or .mdx page`);
  const stem = match[1];
  for (const part of stem.split('/')) {
    if (!SLUG_PART.test(part)) {
      const renamed = part.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
      throw new Error(
        `${sourcePath} has the part "${part}", which Astro publishes under a different name. Use only lowercase letters, digits, hyphens and underscores in page paths, such as "${renamed}".`,
      );
    }
  }
  if (stem === 'index') return 'index.html';
  if (stem.endsWith('/index')) return `${stem}.html`;
  return `${stem}/index.html`;
}
