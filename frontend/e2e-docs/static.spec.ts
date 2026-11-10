import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { PUBLISHED_ROOT, docsRoot, docsUrl, fetchText, locsOf, sitemapPages, toLocal } from './support/site.ts';

// What a crawler or a link preview reads, fetched with no browser: each page's title, description,
// canonical link, preview-image tags and first paragraph; the sitemap; the preview image itself;
// and the 404 page.
//
// The expected title, description and paragraph come from each page's source file under
// site/src/content/docs/, read at run time, so a new page is checked with no change here.

const SITE_DIR = path.resolve(import.meta.dirname, '../../site');
const CONTENT_DIR = path.join(SITE_DIR, 'src/content/docs');
const DIST_DIR = path.join(SITE_DIR, 'dist');

const OG_IMAGE = `${PUBLISHED_ROOT}og/default.png`;
const OG_IMAGE_ALT =
  'The Fabrico wordmark with an amber square as the dot of the i, above a conveyor belt and the line THE GRID IS THE PROGRAM.';

/** Curly quotes made straight and runs of space made one, so markdown and HTML compare as text. */
function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Undo the HTML entities Astro writes in text and attribute values. */
function decode(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A page's source file, from its path under /fabrico/ (`''` is the root, `concepts/` a section). */
function sourceOf(pagePath: string): string {
  const slug = pagePath.replace(/\/$/, '');
  const candidates =
    slug === ''
      ? ['index.mdx', 'index.md']
      : [`${slug}/index.mdx`, `${slug}/index.md`, `${slug}.mdx`, `${slug}.md`];
  for (const rel of candidates) {
    const file = path.join(CONTENT_DIR, rel);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`/fabrico/${pagePath} has no source file under site/src/content/docs/ (tried ${candidates.join(', ')})`);
}

/** The title, description and first prose paragraph of a page's source, as plain text. */
function readSource(file: string): { title: string; description: string; paragraph: string } {
  const text = fs.readFileSync(file, 'utf8');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (match === null) throw new Error(`${file} has no frontmatter`);
  const field = (name: string): string => {
    const line = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(match[1]);
    if (line === null) throw new Error(`${file} has no ${name} in its frontmatter`);
    return line[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  };
  // The first block of text that isn't an import, a component or a heading.
  const blocks = match[2].split(/\n\s*\n/).map((b) => b.trim());
  const prose = blocks.find((b) => b !== '' && !/^(import\s|export\s|<|#|```)/.test(b));
  if (prose === undefined) throw new Error(`${file} has no prose paragraph`);
  const paragraph = prose
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) to text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
  return { title: field('title'), description: field('description'), paragraph: plain(paragraph) };
}

/** Every tag of one name in the HTML head, as attribute maps. */
function headTags(html: string, tag: 'meta' | 'link'): Record<string, string>[] {
  const head = html.slice(0, html.indexOf('</head>'));
  return [...head.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])])),
  );
}

/** The content of the one `<meta>` whose `key` attribute is `name`; fails on none or several. */
function metaContent(html: string, key: 'name' | 'property', name: string, where: string): string {
  const found = headTags(html, 'meta').filter((m) => m[key] === name);
  expect(found.length, `${where}: <meta ${key}="${name}"> tags`).toBe(1);
  return found[0].content ?? '';
}

/** The page's visible text: tags, scripts and styles removed, entities decoded. */
function textOf(html: string): string {
  const body = html.slice(html.indexOf('<body'));
  return plain(decode(body.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ')));
}

/** The published URL of every page in site/dist/ other than 404.html, sorted. */
function builtPages(): string[] {
  const pages: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html') && full !== path.join(DIST_DIR, '404.html')) {
        const rel = path.relative(DIST_DIR, full).split(path.sep).join('/');
        pages.push(PUBLISHED_ROOT + rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '/'));
      }
    }
  };
  walk(DIST_DIR);
  return pages.sort();
}

const pages = await sitemapPages();
const pathOf = (local: string): string => local.slice(docsUrl('').length);

test('the sitemap lists exactly the built pages other than 404', async () => {
  const index = await fetchText(docsUrl('sitemap-index.xml'));
  const sitemaps = locsOf(index);
  expect(sitemaps, 'the sitemaps sitemap-index.xml names').toEqual([`${PUBLISHED_ROOT}sitemap-0.xml`]);
  const listed = locsOf(await fetchText(toLocal(sitemaps[0]))).sort();
  expect(listed, 'sitemap-0.xml against the pages in site/dist/').toEqual(builtPages());
  expect(listed.length, 'pages in sitemap-0.xml').toBeGreaterThanOrEqual(7);
});

test('the published site holds no test page', async () => {
  // Test pages have a file name starting with _ and build only into site/dist-fixtures/.
  const listed = locsOf(await fetchText(docsUrl('sitemap-0.xml')));
  expect(listed.filter((u) => u.includes('_fixture')), 'sitemap-0.xml URLs with _fixture').toEqual([]);
  expect(builtPages().filter((u) => u.slice(PUBLISHED_ROOT.length).split('/').some((p) => p.startsWith('_'))), 'pages in site/dist/ under a name starting with _').toEqual([]);
});

for (const url of pages) {
  const pagePath = pathOf(url);
  const where = `/fabrico/${pagePath}`;
  test(`${where}: title, description, canonical, preview image and prose are in the static HTML`, async () => {
    const response = await fetch(url);
    expect(response.status, `${where}: status`).toBe(200);
    const html = await response.text();
    const source = readSource(sourceOf(pagePath));

    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(title === undefined ? undefined : decode(title), `${where}: <title>`).toBe(`${source.title} | Fabrico`);
    expect(metaContent(html, 'name', 'description', where), `${where}: meta description`).toBe(source.description);

    const canonical = headTags(html, 'link').filter((l) => l.rel === 'canonical');
    expect(canonical.length, `${where}: canonical links`).toBe(1);
    expect(canonical[0].href, `${where}: canonical link`).toBe(PUBLISHED_ROOT + pagePath);

    expect(metaContent(html, 'property', 'og:image', where), `${where}: og:image`).toBe(OG_IMAGE);
    expect(metaContent(html, 'name', 'twitter:image', where), `${where}: twitter:image`).toBe(OG_IMAGE);
    expect(metaContent(html, 'property', 'og:image:width', where), `${where}: og:image:width`).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height', where), `${where}: og:image:height`).toBe('630');
    expect(metaContent(html, 'property', 'og:image:alt', where), `${where}: og:image:alt`).toBe(OG_IMAGE_ALT);
    expect(metaContent(html, 'name', 'twitter:card', where), `${where}: twitter:card`).toBe('summary_large_image');

    expect(textOf(html), `${where}: the first paragraph of its source, in the HTML`).toContain(source.paragraph);
  });
}

test('the preview image is served as a 1200 x 630 PNG', async () => {
  const response = await fetch(docsUrl('og/default.png'));
  expect(response.status, 'og/default.png status').toBe(200);
  const png = Buffer.from(await response.arrayBuffer());
  expect(png.subarray(1, 4).toString('latin1'), 'og/default.png PNG signature').toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], 'og/default.png width and height').toEqual([1200, 630]);
});

test('a folder asked for without its trailing slash gets status 301 to the path with the slash, query kept', async () => {
  // GitHub Pages answers this way, so a link written without the slash works once published. The
  // static link check accepts `x` for `x/index.html`, and the served site must agree with it.
  const origin = new URL(docsRoot()).origin;
  const cases: [string, string][] = [
    ['/fabrico/get-started', '/fabrico/get-started/'],
    ['/fabrico/get-started?from=probe', '/fabrico/get-started/?from=probe'],
    ['/fabrico', '/fabrico/'],
  ];
  for (const [asked, location] of cases) {
    const response = await fetch(origin + asked, { redirect: 'manual' });
    expect(response.status, `${asked} status`).toBe(301);
    expect(response.headers.get('location'), `${asked} location`).toBe(location);
    const followed = await fetch(origin + asked);
    expect(followed.status, `${asked}, redirect followed, status`).toBe(200);
  }
  const missing = await fetch(`${origin}/fabrico/no-such-page`, { redirect: 'manual' });
  expect(missing.status, '/fabrico/no-such-page status').toBe(404);
  const file = await fetch(`${origin}/fabrico/og/default.png`, { redirect: 'manual' });
  expect(file.status, '/fabrico/og/default.png, a file, status').toBe(200);
});

test('an unknown address gets status 404 and the not-found page', async () => {
  const response = await fetch(docsUrl('no-such-page/'));
  expect(response.status, '/fabrico/no-such-page/ status').toBe(404);
  expect(textOf(await response.text()), '/fabrico/no-such-page/ text').toContain("There's no page at this address.");
});
