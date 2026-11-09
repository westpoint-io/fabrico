// The docs site. It builds to static HTML under dist/, served from the GitHub Pages address of
// the public repository, so every page URL starts with /fabrico/.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const SITE = 'https://westpoint-io.github.io';
const BASE = '/fabrico';

/** The repository the docs live in, for the edit and GitHub links. */
const REPO = 'https://github.com/westpoint-io/fabrico';

/**
 * The image link previews show for every page, written by frontend/scripts/build-og.ts. Head
 * entries aren't given the base path, and link previews need an absolute URL, so it's spelled out.
 */
const OG_IMAGE = `${SITE}${BASE}/og/default.png`;
const OG_IMAGE_ALT =
  'The Fabrico wordmark above a conveyor belt carrying one amber item, with the line THE GRID IS THE PROGRAM.';

/** One sidebar group listing every page in a folder under src/content/docs/. */
const group = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

/** A `<meta>` head entry. */
const meta = (key, name, content) => ({ tag: 'meta', attrs: { [key]: name, content } });

export default defineConfig({
  site: SITE,
  base: BASE,
  // The dev server reads the board files under ../examples/.
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'Fabrico',
      description:
        'Docs for Fabrico, the open-source automation engine you build like a factory: machines on a grid, wired with belts, on a deterministic core.',
      // The edit URL is this base plus the page's path from site/, such as src/content/docs/....
      editLink: { baseUrl: `${REPO}/edit/main/site/` },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // The app's tokens first (written from its locked skin by build-site-assets.ts), then the
      // theme that maps Starlight's variables onto them.
      customCss: ['./src/styles/generated/fab-tokens.css', './src/styles/theme.css'],
      head: [
        meta('property', 'og:image', OG_IMAGE),
        meta('property', 'og:image:width', '1200'),
        meta('property', 'og:image:height', '630'),
        meta('property', 'og:image:alt', OG_IMAGE_ALT),
        meta('name', 'twitter:image', OG_IMAGE),
      ],
      // Six groups in a fixed order, each listing its folder's pages. Groups start expanded.
      sidebar: [
        group('Get started', 'get-started'),
        group('Concepts', 'concepts'),
        group('Reference', 'reference'),
        group('Patterns', 'patterns'),
        group('Troubleshooting', 'troubleshooting'),
        group('Contributing', 'contributing'),
      ],
    }),
  ],
});
