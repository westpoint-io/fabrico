import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { descriptionError } from './lib/frontmatter.ts';

/**
 * Starlight's `description`, required and held to the length rule in lib/frontmatter.ts. It's a
 * required string rather than an optional one with a check: Zod doesn't run an optional field's
 * checks when the key is absent, so a page with no description would build.
 */
const description = z
  .string({ error: (issue) => (issue.input === undefined ? (descriptionError(undefined) ?? undefined) : undefined) })
  .superRefine((value, ctx) => {
    const message = descriptionError(value);
    if (message !== null) ctx.addIssue({ code: 'custom', message });
  });

/**
 * Pages whose file name starts with _ are test fixtures for the docs suite. Starlight's docsLoader
 * skips them: it is the glob loader with the pattern `**\/[^_]*.{md,mdx,...}`. With
 * FABRICO_DOCS_FIXTURES=1 the build swaps in the same glob without that filter and writes to
 * dist-fixtures/ (see astro.config.mjs), so fixture pages never reach the published dist/.
 */
const withFixtures = process.env.FABRICO_DOCS_FIXTURES === '1';
const docsPages = withFixtures ? glob({ base: './src/content/docs', pattern: '**/*.{md,mdx}' }) : docsLoader();

export const collections = {
  docs: defineCollection({ loader: docsPages, schema: docsSchema({ extend: z.object({ description }) }) }),
  // The site's own interface strings (search, edit link, pagination): src/content/i18n/en.json.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
