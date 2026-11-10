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
  'The Fabrico wordmark with an amber square as the dot of the i, above a conveyor belt and the line THE GRID IS THE PROGRAM.';

/** A font the page head preloads. Head entries aren't given the base path, so it's written here. */
const preloadFont = (file) => ({
  tag: 'link',
  attrs: { rel: 'preload', href: `${BASE}/fonts/${file}`, as: 'font', type: 'font/woff2', crossorigin: true },
});

/** One sidebar group listing every page in a folder under src/content/docs/. */
const group = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

/** A `<meta>` head entry. */
const meta = (key, name, content) => ({ tag: 'meta', attrs: { [key]: name, content } });

/**
 * With FABRICO_DOCS_FIXTURES=1 the build also takes the test pages whose file name starts with _
 * (src/content.config.ts) and writes to dist-fixtures/, which the docs suite serves on a second
 * port. dist/ is the folder that gets published, and it never holds a test page.
 */
const OUT_DIR = process.env.FABRICO_DOCS_FIXTURES === '1' ? './dist-fixtures' : './dist';

export default defineConfig({
  site: SITE,
  base: BASE,
  outDir: OUT_DIR,
  // The dev server serves only this folder, the board files under ../examples/boards/ and the one
  // frontend file the board helpers import. Allowing the whole checkout would also serve the
  // ignored files beside it, such as private notes, to anyone who can reach a dev server started
  // with --host. Setting `allow` leaves Vite's default deny list (.env, keys, .git) in place.
  vite: { server: { fs: { allow: ['.', '../examples/boards', '../frontend/src/embed/boardIds.ts'] } } },
  integrations: [
    starlight({
      title: 'Fabrico',
      description:
        'Docs for Fabrico, the open-source automation engine you build like a factory: machines on a grid, wired with belts, on a deterministic core.',
      // The edit URL is this base plus the page's path from site/, such as src/content/docs/....
      editLink: { baseUrl: `${REPO}/edit/main/site/` },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      // The brand icon beside the visible title, and the 16-unit cut as the favicon. The build copies
      // both from docs/brand/. The alt is empty because the title next to the icon says the name.
      logo: { src: './src/assets/generated/fabrico-icon-master.svg', alt: '' },
      favicon: '/favicon.svg',
      // The app's tokens first (written from its locked skin by build-site-assets.ts), then its
      // two fonts, then the theme that maps Starlight's variables onto both.
      customCss: ['./src/styles/generated/fab-tokens.css', './src/styles/fonts.css', './src/styles/theme.css'],
      // Dark only: the theme is set before first paint, and the light, dark and auto picker is gone.
      components: {
        ThemeProvider: './src/components/overrides/ThemeProvider.astro',
        ThemeSelect: './src/components/overrides/ThemeSelect.astro',
      },
      head: [
        meta('property', 'og:image', OG_IMAGE),
        meta('property', 'og:image:width', '1200'),
        meta('property', 'og:image:height', '630'),
        meta('property', 'og:image:alt', OG_IMAGE_ALT),
        meta('name', 'twitter:image', OG_IMAGE),
        preloadFont('MartianMono.woff2'),
        preloadFont('Sono.woff2'),
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
