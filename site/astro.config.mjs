// The docs site. It builds to static HTML under dist/, served from the GitHub Pages address of
// the public repository, so every page URL starts with /fabrico/.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const SITE = 'https://westpoint-io.github.io';
const BASE = '/fabrico';

/** One sidebar group listing every page in a folder under src/content/docs/. */
const group = (label, directory) => ({ label, items: [{ autogenerate: { directory } }] });

export default defineConfig({
  site: SITE,
  base: BASE,
  // The dev server reads the board files under ../examples/.
  vite: { server: { fs: { allow: ['..'] } } },
  integrations: [
    starlight({
      title: 'Fabrico',
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
