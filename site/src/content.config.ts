import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { descriptionError } from './lib/frontmatter.ts';

/** Starlight's `description`, required and held to the length rule in lib/frontmatter.ts. */
const description = z
  .string()
  .optional()
  .superRefine((value, ctx) => {
    const message = descriptionError(value);
    if (message !== null) ctx.addIssue({ code: 'custom', message });
  });

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema({ extend: z.object({ description }) }) }),
  // The site's own interface strings (search, edit link, pagination): src/content/i18n/en.json.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
