import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { docsUrl } from './support/site.ts';

// Troubleshooting coverage. Every fault reason and every refusal message in the generated facts has
// exactly one entry on the built troubleshooting pages: a section marked data-fix="<fact id>" whose
// one h3 carries the anchor id this spec computes itself from the fact id. Heading ids are unique
// across the troubleshooting pages, so two entries can't share an anchor. Opening a refusal's anchor
// puts its heading below the fixed header and marks its entry with the 3 px ink rail.
//
// The ids come from site/src/generated/facts.json, which the facts exporter writes from the code,
// never from a list kept under site/, so a site edit can't switch the check off. The file and the
// built pages are read from disk at run time, never imported: a docs-only change doesn't run the
// frontend's type check, so the suite must not depend on site/ files at compile time.

const REPO = path.resolve(import.meta.dirname, '../..');
const FACTS = path.join(REPO, 'site/src/generated/facts.json');
const TROUBLESHOOTING_DIST = path.join(REPO, 'site/dist/troubleshooting');

/** The fewest fault reasons and refusals facts.json may hold. A read that finds fewer is broken. */
const MIN_FAULTS = 9;
const MIN_REFUSALS = 40;

/**
 * The anchor id for a fault.* or refusal.* fact id: the prefix, a hyphen, then the name with a
 * hyphen before each capital that follows a lower-case letter or digit, all lower-cased.
 * refusal.BeltTooLong gives refusal-belt-too-long.
 */
function anchorOf(id: string): string {
  const dot = id.indexOf('.');
  const prefix = id.slice(0, dot);
  const name = id.slice(dot + 1).replace(/([a-z0-9])([A-Z])/g, '$1-$2');
  return `${prefix}-${name}`.toLowerCase();
}

/** Every index.html under a folder, as absolute paths, sorted. */
function htmlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name === 'index.html') out.push(full);
  }
  return out.sort();
}

/**
 * The whole element whose opening tag starts at `open`: from its `<` to its matching close tag,
 * counting nested tags of the same name.
 */
function elementFrom(html: string, open: number): string {
  const tag = /^<([a-z][a-z0-9-]*)/i.exec(html.slice(open))?.[1];
  if (tag === undefined) return '';
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return html.slice(open, m.index + m[0].length);
  }
  return html.slice(open);
}

interface FixEntry {
  id: string;
  page: string;
  h3Ids: (string | null)[];
}

/** Every [data-fix] element on the built troubleshooting pages, with the ids of the h3s inside it. */
function fixEntries(): FixEntry[] {
  const out: FixEntry[] = [];
  for (const file of htmlFiles(TROUBLESHOOTING_DIST)) {
    const html = fs.readFileSync(file, 'utf8');
    const page = path.relative(REPO, file);
    for (const m of html.matchAll(/<[a-z][a-z0-9-]*\b[^>]*\bdata-fix="([^"]*)"[^>]*>/gi)) {
      const element = elementFrom(html, m.index);
      const h3Ids = [...element.matchAll(/<h3\b([^>]*)>/gi)].map((h) => /\bid="([^"]*)"/.exec(h[1])?.[1] ?? null);
      out.push({ id: m[1], page, h3Ids });
    }
  }
  return out;
}

test('the spec computes the anchor id the troubleshooting entries use', () => {
  expect(anchorOf('refusal.BeltTooLong')).toBe('refusal-belt-too-long');
  expect(anchorOf('fault.NoEntryWire')).toBe('fault-no-entry-wire');
  expect(anchorOf('fault.BranchBusy')).toBe('fault-branch-busy');
  expect(anchorOf('fault.NoMatch')).toBe('fault-no-match');
});

test('every fault reason and refusal in facts.json has exactly one troubleshooting entry with a well-formed heading', () => {
  const facts = (JSON.parse(fs.readFileSync(FACTS, 'utf8')) as { facts: Record<string, unknown> }).facts;
  const faults = Object.keys(facts).filter((id) => id.startsWith('fault.')).sort();
  const refusals = Object.keys(facts).filter((id) => id.startsWith('refusal.')).sort();
  expect(faults.length, 'fault.* ids in site/src/generated/facts.json').toBeGreaterThanOrEqual(MIN_FAULTS);
  expect(refusals.length, 'refusal.* ids in site/src/generated/facts.json').toBeGreaterThanOrEqual(MIN_REFUSALS);

  const entries = fixEntries();
  const problems: string[] = [];
  let found = 0;
  for (const id of [...faults, ...refusals]) {
    const mine = entries.filter((e) => e.id === id);
    if (mine.length === 0) {
      problems.push(`${id}: no [data-fix="${id}"] under site/dist/troubleshooting/`);
      continue;
    }
    if (mine.length > 1) {
      problems.push(`${id}: ${mine.length} entries (${mine.map((e) => e.page).join(', ')})`);
      continue;
    }
    const { page, h3Ids } = mine[0];
    const want = anchorOf(id);
    if (h3Ids.length !== 1) {
      problems.push(`${id}: the entry in ${page} holds ${h3Ids.length} h3 headings, not 1`);
      continue;
    }
    if (h3Ids[0] !== want) {
      problems.push(`${id}: the entry's h3 in ${page} has id ${h3Ids[0] === null ? 'none' : `"${h3Ids[0]}"`}, not "${want}"`);
      continue;
    }
    found += 1;
  }

  const seen = new Map<string, string>();
  for (const { page, h3Ids } of entries) {
    for (const h3 of h3Ids) {
      if (h3 === null) continue;
      const first = seen.get(h3);
      if (first !== undefined) problems.push(`the h3 id "${h3}" appears twice: ${first} and ${page}`);
      else seen.set(h3, page);
    }
  }

  const total = faults.length + refusals.length;
  console.log(`TROUBLESHOOTING faults=${faults.length} refusals=${refusals.length} missing=${total - found}`);
  expect(problems, `fault reasons and refusals without a well-formed troubleshooting entry (${problems.length})`).toEqual([]);
});

test("opening a refusal's anchor puts its heading under the header and marks its entry", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const response = await page.goto(docsUrl('troubleshooting/refusals/#refusal-belt-too-long'));
  expect(response?.status(), 'troubleshooting/refusals/ answers').toBe(200);
  const heading = page.locator('h3#refusal-belt-too-long');
  await expect(heading, 'the h3 with id refusal-belt-too-long').toHaveCount(1);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const measured = await page.evaluate(() => {
    const h3 = document.getElementById('refusal-belt-too-long');
    const header = document.querySelector('.page > .header');
    const section = h3?.closest('[data-fix]');
    if (h3 === null || header === null || section === null || section === undefined) return null;
    const probe = document.createElement('span');
    probe.style.color = 'var(--fab-ink)';
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(section);
    return {
      headingTop: h3.getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
      railWidth: style.borderInlineStartWidth,
      railStyle: style.borderInlineStartStyle,
      railColour: style.borderInlineStartColor,
      ink,
    };
  });
  expect(measured, 'the heading, the header and the entry section').not.toBeNull();
  if (measured === null) return;
  expect(measured.headingTop, 'the heading top against the header bottom').toBeGreaterThanOrEqual(measured.headerBottom);
  expect(
    [measured.railWidth, measured.railStyle, measured.railColour],
    "the entry's inline-start rail: 3px solid ink",
  ).toEqual(['3px', 'solid', measured.ink]);
});
