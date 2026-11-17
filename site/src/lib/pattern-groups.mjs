// The Patterns sidebar's subgroups, in sidebar order: each one is [label, slugs], where every slug is
// a page at src/content/docs/patterns/<slug>.mdx. astro.config.mjs builds the Patterns group from
// this list, and tests/unit/patterns-sidebar.test.ts checks it: each pattern page sits in exactly
// one subgroup, each slug has a page, and the labels equal the h2 headings of patterns/index.mdx in
// the same order. A subgroup joins this list in the same change that adds its first page and its
// heading on the index page. The pages keep their URLs, patterns/<slug>; only the sidebar groups them.

/** @type {[label: string, slugs: string[]][]} */
export const PATTERN_GROUPS = [
  ['Move and copy events', ['forward-a-webhook', 'send-to-multiple-urls', 'combine-several-sources']],
  ['Shape events', ['transform-json-payload', 'filter-events', 'split-an-array']],
  ['Route events', ['route-by-content', 'split-traffic']],
  ['Pace and spread the work', ['parallel-workers', 'buffer-events', 'rate-limit', 'run-on-a-schedule']],
  ['Handle failures', ['dead-letter-queue', 'request-timeout', 'validate-webhook-payloads']],
  ['Keep state', ['running-total', 'deduplicate-events', 'batch-events']],
  ['HTTP and whole flows', ['local-http-endpoint']],
];
