// capture-report.ts - one HTML page per board capture run: each capture beside the numbers measured
// from it and the verdicts of the tests that graded those numbers.
//
// The capture set (`npm run e2e:capture`) writes one folder per boot under `test-results/capture/`,
// each holding its PNGs and a `manifest.json`, and a Playwright JSON report at
// `test-results/capture-report.json`. This script reads both and writes
// `test-results/capture/index.html`, which CI uploads with the PNGs as one artifact. A person opens
// the page to see what the board looked like and what was measured on it, without re-running
// anything.
//
// THE PAGE IS FOR PEOPLE, NOT THE VERDICT. The capture run's exit code decides whether it passed.
// This page shows each grading verdict as the report gives it, and lists any test it could
// not place beside a capture in a section of its own, so nothing in the report is left off the page.
//
// LAYOUT. One section per boot (a pixel ratio and an antialiasing setting), ordered by ratio and
// then shipped before on. In each, one block per capture cell in manifest order: the PNG at its
// natural size in a scrolling box (the tiles of a panned zoom side by side), and beside it one table
// per measured property. Tables are drawn from the manifest's rows generically, so a property added
// later appears with no change here: scalar fields become columns, nested objects become grouped
// columns, and an object carrying `measured: false` becomes one cell reading "not measured" with its
// reason. Within a row, a value that differs from the most common value among its sibling groups (one
// outline side against the other three) is tinted, so the eye finds it.
//
// SAFE TO PUBLISH. The page loads nothing external, every path in it is relative to the page, every
// string is HTML-escaped, and absolute paths in test messages are cut to paths inside the repository.
// The revision and the run's start time are the only facts about the run it records.
//
// EXIT CODES: 0 when the page was written; 2 when no manifest was found or the report can't be read.
// The last stdout line on success is `CAPTURE PAGE captures=<n> path=test-results/capture/index.html`.
//
// Run from `frontend/` as `node scripts/capture-report.ts`. Every path comes from this file's own
// location, so it runs the same from anywhere. Erasure-only TypeScript, so Node runs it as it is.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIND_NAMES } from '../shared/kindNames.ts';

const FRONTEND = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(FRONTEND, '..');
const RESULTS = path.join(FRONTEND, 'test-results');
const CAPTURE_ROOT = path.join(RESULTS, 'capture');
const REPORT = path.join(RESULTS, 'capture-report.json');
const PAGE = path.join(CAPTURE_ROOT, 'index.html');
const PAGE_SHOWN = 'test-results/capture/index.html';

/** The spec file whose expected failures may be declared, and the tags that may declare one. */
const GRADE_FILE = 'board-grade.capture.ts';
const DECLARABLE_TAGS = ['@STRK-01', '@STRK-02', '@STRK-03'];

/**
 * A failure message is shown up to its first blank line (the test's own explanation, before
 * Playwright's diff of it), and never more than this many lines.
 */
const MESSAGE_LINES = 14;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface ManifestEntry {
  cell: { dpr: number; aa: string; zoom: string | number };
  /** The zoom's token in test titles (`boot`, `fullscreen-boot`, or the scale), when the manifest records it. */
  zoomId?: string;
  png: string;
  camera?: { x: number; y: number; scale: number };
  gl?: { antialias: boolean | null; samples: number | null };
  measurements?: Record<string, JsonObject[]>;
}

interface Manifest {
  boot: { dpr: number; aa: string };
  entries: ManifestEntry[];
}

type Verdict = 'passed' | 'declared' | 'expected-fail' | 'failed' | 'flaky' | 'skipped' | 'did-not-run';

interface ReportTest {
  file: string;
  title: string;
  project: string;
  verdict: Verdict;
  tags: string[];
  fixedBy: string[];
  message: string;
  shown: boolean;
}

function fail(message: string): never {
  console.error(`capture-report: ${message}`);
  process.exit(2);
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Drop terminal colour codes and cut absolute paths down to paths inside the repository. */
function cleanMessage(raw: string): string {
  let s = raw.replace(/\u001b\[[0-9;]*m/g, '');
  s = s.split(`${REPO}${path.sep}`).join('');
  return s.replace(/(?:\/(?:home|Users|root|tmp|private|var)\/|[A-Za-z]:\\)\S*/g, '<path>');
}

// --- the report ---------------------------------------------------------------------------------

function classify(test: JsonObject): Verdict {
  const results = Array.isArray(test.results) ? test.results : [];
  const expected = typeof test.expectedStatus === 'string' ? test.expectedStatus : 'passed';
  if (results.length === 0) return 'did-not-run';
  switch (test.status) {
    case 'skipped':
      return expected === 'skipped' ? 'skipped' : 'did-not-run';
    case 'flaky':
      return 'flaky';
    case 'expected':
      return expected === 'passed' ? 'passed' : 'expected-fail';
    default:
      return 'failed';
  }
}

function readReport(): { tests: ReportTest[]; startTime: string | null } {
  if (!existsSync(REPORT)) fail(`no report at ${path.relative(FRONTEND, REPORT)}: run npm run e2e:capture first`);
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(REPORT, 'utf8'));
  } catch (e) {
    fail(`the report at ${path.relative(FRONTEND, REPORT)} can't be read as JSON (${(e as Error).message})`);
  }
  if (!isObject(report) || !Array.isArray(report.suites)) fail('the report has no suites array');
  const tests: ReportTest[] = [];
  const walk = (suite: JsonObject): void => {
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      if (!isObject(spec)) continue;
      for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
        if (!isObject(test)) continue;
        const rawTags = [...(Array.isArray(test.tags) ? test.tags : []), ...(Array.isArray(spec.tags) ? spec.tags : [])];
        const tags = [...new Set(rawTags.map((t) => `@${String(t).replace(/^@/, '')}`))];
        const annotations = Array.isArray(test.annotations) ? test.annotations : [];
        const fixedBy = annotations.filter((a) => isObject(a) && a.type === 'fixed-by').map((a) => String((a as JsonObject).description ?? ''));
        const results = Array.isArray(test.results) ? test.results : [];
        const last = results.length > 0 ? results[results.length - 1] : null;
        const error = isObject(last) && isObject(last.error) ? last.error : null;
        const file = String(spec.file ?? '');
        let verdict = classify(test);
        if (verdict === 'expected-fail') {
          const strk = tags.filter((t) => t.startsWith('@STRK-'));
          if (path.basename(file) === GRADE_FILE && strk.length === 1 && DECLARABLE_TAGS.includes(strk[0])) verdict = 'declared';
        }
        tests.push({
          file,
          title: String(spec.title ?? ''),
          project: String(test.projectName ?? ''),
          verdict,
          tags,
          fixedBy,
          message: error !== null && typeof error.message === 'string' ? cleanMessage(error.message) : '',
          shown: false,
        });
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) if (isObject(child)) walk(child);
  };
  for (const suite of report.suites) if (isObject(suite)) walk(suite);
  const stats = isObject(report.stats) ? report.stats : null;
  return { tests, startTime: stats !== null && typeof stats.startTime === 'string' ? stats.startTime : null };
}

/**
 * The title token of an entry's zoom, as the capture and grading tests write it: the manifest's
 * own `zoomId` when it records one (a named zoom such as `fullscreen-boot` is a number in `cell`),
 * else `boot` or the scale.
 */
function zoomToken(entry: ManifestEntry): string {
  if (typeof entry.zoomId === 'string' && entry.zoomId !== '') return entry.zoomId;
  return typeof entry.cell.zoom === 'number' ? String(entry.cell.zoom) : entry.cell.zoom;
}

/** The grading tests for one property and one cell, matched by their title `<property> dpr=<r> aa=<a> zoom=<z>`. */
function gradingTests(tests: ReportTest[], property: string, entry: ManifestEntry): ReportTest[] {
  const cell = entry.cell;
  const want = `${property} dpr=${cell.dpr} aa=${cell.aa} zoom=${zoomToken(entry)}`;
  return tests.filter((t) => path.basename(t.file) === GRADE_FILE && (t.title === want || t.title.startsWith(`${want} `)));
}

/** The capture test for one boot, titled `capture dpr=<r> aa=<a>`. */
function captureTests(tests: ReportTest[], boot: Manifest['boot']): ReportTest[] {
  const want = `capture dpr=${boot.dpr} aa=${boot.aa}`;
  return tests.filter((t) => path.basename(t.file) !== GRADE_FILE && (t.title === want || t.title.startsWith(`${want} `)));
}

// --- the manifests ------------------------------------------------------------------------------

function readManifests(): { dir: string; manifest: Manifest }[] {
  if (!existsSync(CAPTURE_ROOT)) fail(`no capture folder at ${path.relative(FRONTEND, CAPTURE_ROOT)}: run npm run e2e:capture first`);
  const out: { dir: string; manifest: Manifest }[] = [];
  for (const dir of readdirSync(CAPTURE_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(CAPTURE_ROOT, dir.name, 'manifest.json');
    if (!existsSync(file)) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      fail(`${path.relative(FRONTEND, file)} can't be read as JSON (${(e as Error).message})`);
    }
    if (!isObject(manifest) || !isObject(manifest.boot) || !Array.isArray(manifest.entries)) {
      fail(`${path.relative(FRONTEND, file)} has no boot or no entries array`);
    }
    out.push({ dir: dir.name, manifest: manifest as unknown as Manifest });
  }
  if (out.length === 0) fail(`no manifest.json under ${path.relative(FRONTEND, CAPTURE_ROOT)}: the capture tests wrote none`);
  const aaOrder = (aa: string): number => (aa === 'shipped' ? 0 : aa === 'on' ? 1 : 2);
  return out.sort((a, b) => a.manifest.boot.dpr - b.manifest.boot.dpr || aaOrder(a.manifest.boot.aa) - aaOrder(b.manifest.boot.aa));
}

/** A PNG's width and height from its header, or null when the file isn't a PNG. */
function pngSize(file: string): { width: number; height: number } | null {
  const head = readFileSync(file).subarray(0, 24);
  if (head.length < 24 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** Consecutive entries of one cell (the tiles of one zoom) grouped together, in manifest order. */
function cellsOf(entries: ManifestEntry[]): ManifestEntry[][] {
  const groups: ManifestEntry[][] = [];
  for (const e of entries) {
    const prev = groups[groups.length - 1];
    if (prev !== undefined && JSON.stringify(prev[0].cell) === JSON.stringify(e.cell)) prev.push(e);
    else groups.push([e]);
  }
  return groups;
}

// --- generic property tables --------------------------------------------------------------------

/** A column, or a group of columns under one header. `path` is the field path from the row. */
interface Column {
  label: string;
  path: string[];
  children: Column[];
}

/** Fields an object uses to say whether it was measured; shown as one spanning cell, never as columns. */
const STATUS_FIELDS = new Set(['measured', 'reason']);

/**
 * Fields that say how a reading was made (how many sample lines were read or refused) rather than
 * what was measured. They are shown muted and never tinted, because their spread between sides is
 * expected: a side with a port nub on it has room for fewer lines.
 */
const READING_FIELDS = new Set(['lines', 'skipped']);

function columnsOf(values: Json[], prefix: string[]): Column[] {
  const order: string[] = [];
  const byKey = new Map<string, Json[]>();
  for (const v of values) {
    if (!isObject(v)) continue;
    for (const [k, child] of Object.entries(v)) {
      if (STATUS_FIELDS.has(k) && typeof v.measured === 'boolean') continue;
      if (!byKey.has(k)) {
        byKey.set(k, []);
        order.push(k);
      }
      byKey.get(k)?.push(child);
    }
  }
  return order.map((k) => {
    const vs = byKey.get(k) ?? [];
    const nested = vs.some(isObject);
    return { label: k, path: [...prefix, k], children: nested ? columnsOf(vs, [...prefix, k]) : [] };
  });
}

function leafCount(c: Column): number {
  return c.children.length === 0 ? 1 : c.children.reduce((n, ch) => n + leafCount(ch), 0);
}

function depthOf(cols: Column[]): number {
  return cols.reduce((d, c) => Math.max(d, 1 + depthOf(c.children)), 0);
}

function at(row: Json, p: string[]): Json | undefined {
  let v: Json | undefined = row;
  for (const k of p) v = isObject(v) ? v[k] : undefined;
  return v;
}

function formatValue(key: string, v: Json | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number') {
    const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
    return key === 'kind' && KIND_NAMES[v] !== undefined ? `${n} ${KIND_NAMES[v]}` : n;
  }
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return String(v);
  return JSON.stringify(v);
}

/**
 * Leaf paths whose value differs from the most common value at the same field among sibling groups
 * of one row: for `sides.right.core` the siblings are `sides.top.core`, `sides.bottom.core` and
 * `sides.left.core`. Only groups of three or more siblings are compared, so a majority exists.
 */
function oddLeaves(row: JsonObject, cols: Column[]): Set<string> {
  const odd = new Set<string>();
  const visit = (c: Column): void => {
    if (c.children.length >= 3 && c.children.every((g) => g.children.length > 0)) {
      const fields = new Set(c.children.flatMap((g) => g.children.filter((f) => f.children.length === 0).map((f) => f.label)));
      for (const f of fields) {
        if (READING_FIELDS.has(f)) continue;
        const vals = c.children.map((g) => at(row, [...g.path, f])).filter((v): v is number => typeof v === 'number');
        if (vals.length < 3) continue;
        const counts = new Map<number, number>();
        for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
        const [mode, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        if (modeCount * 2 <= vals.length) continue;
        for (const g of c.children) {
          const v = at(row, [...g.path, f]);
          if (typeof v === 'number' && v !== mode) odd.add([...g.path, f].join('.'));
        }
      }
    }
    for (const ch of c.children) visit(ch);
  };
  for (const c of cols) visit(c);
  return odd;
}

function rowCells(row: JsonObject, cols: Column[], odd: Set<string>): string {
  let html = '';
  for (const c of cols) {
    if (c.children.length === 0) {
      // A group whose every row reads `measured: false` has no fields left to make columns of, so
      // it arrives here as one column; it still reads "not measured" with its reason.
      const leaf = at(row, c.path);
      if (isObject(leaf) && leaf.measured === false) {
        const reason = typeof leaf.reason === 'string' ? `: ${leaf.reason}` : '';
        html += `<td class="unmeasured">not measured${esc(reason)}</td>`;
        continue;
      }
      const key = c.path.join('.');
      const cls = odd.has(key) ? ' odd' : READING_FIELDS.has(c.label) ? ' reading' : '';
      html += `<td class="num${cls}">${esc(formatValue(c.label, at(row, c.path)))}</td>`;
      continue;
    }
    const v = at(row, c.path);
    if (isObject(v) && v.measured === false) {
      const reason = typeof v.reason === 'string' ? `: ${v.reason}` : '';
      html += `<td class="unmeasured" colspan="${leafCount(c)}">not measured${esc(reason)}</td>`;
    } else if (v === undefined) {
      html += `<td class="unmeasured" colspan="${leafCount(c)}">absent</td>`;
    } else {
      html += rowCells(row, c.children, odd);
    }
  }
  return html;
}

function headerRows(cols: Column[]): string {
  const depth = depthOf(cols);
  const rows: string[][] = Array.from({ length: depth }, () => []);
  const place = (c: Column, level: number): void => {
    if (c.children.length === 0) {
      rows[level].push(`<th rowspan="${depth - level}">${esc(c.label)}</th>`);
    } else {
      rows[level].push(`<th colspan="${leafCount(c)}" class="group">${esc(c.label)}</th>`);
      for (const ch of c.children) place(ch, level + 1);
    }
  };
  for (const c of cols) place(c, 0);
  return rows.map((r) => `<tr>${r.join('')}</tr>`).join('');
}

function propertyTable(rows: JsonObject[], caption: string): string {
  if (rows.length === 0) return `<p class="empty">${esc(caption)}: no rows were measured.</p>`;
  const cols = columnsOf(rows, []);
  const body = rows.map((r) => `<tr>${rowCells(r, cols, oddLeaves(r, cols))}</tr>`).join('');
  return `<div class="table-scroll"><table><caption>${esc(caption)}</caption><thead>${headerRows(cols)}</thead><tbody>${body}</tbody></table></div>`;
}

// --- verdicts -----------------------------------------------------------------------------------

const VERDICT_TEXT: Record<Verdict, string> = {
  passed: 'passed',
  declared: 'declared',
  'expected-fail': 'expected failure, not declared',
  failed: 'failed',
  flaky: 'flaky',
  skipped: 'skipped',
  'did-not-run': 'did not run',
};

function verdictHtml(t: ReportTest): string {
  t.shown = true;
  const strk = t.tags.filter((g) => g.startsWith('@STRK-'));
  let detail = '';
  if (t.verdict === 'declared' || t.verdict === 'expected-fail') {
    detail += `<span class="tag">${esc(strk.join(' ') || 'no STRK tag')}</span>`;
    for (const why of t.fixedBy) detail += `<p class="fixed-by">fixed by: ${esc(why)}</p>`;
  }
  if (t.message !== '' && t.verdict !== 'passed') {
    const lines = t.message.split('\n');
    const blank = lines.findIndex((l) => l.trim() === '');
    const keep = Math.min(blank > 0 ? blank : lines.length, MESSAGE_LINES);
    const head = lines.slice(0, keep).join('\n');
    const rest = lines.slice(keep).filter((l) => l.trim() !== '').length;
    const more = rest > 0 ? `\n(${rest} more lines in the report)` : '';
    detail += `<pre class="message">${esc(head + more)}</pre>`;
  }
  return `<li class="verdict v-${t.verdict}"><span class="pill">${esc(VERDICT_TEXT[t.verdict])}</span> <span class="title">${esc(t.title)}</span>${detail}</li>`;
}

function verdictList(tests: ReportTest[], none: string): string {
  if (tests.length === 0) return `<p class="empty">${esc(none)}</p>`;
  return `<ul class="verdicts">${tests.map(verdictHtml).join('')}</ul>`;
}

// --- the page -----------------------------------------------------------------------------------

function revision(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const CSS = `
:root { color-scheme: dark; --bg: #14171c; --panel: #1c2028; --line: #2c323d; --text: #dde3ec; --muted: #8f9aab;
  --ok: #3fb27f; --warn: #d9a441; --bad: #e5534b; --odd: #5a3a12; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 28px 48px; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
h3 { font-size: 15px; margin: 0 0 10px; }
.meta { color: var(--muted); margin: 0 0 14px; }
.meta code { color: var(--text); }
.legend { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 14px; max-width: 900px; }
.legend dt { font-weight: 600; } .legend dd { margin: 0 0 6px 0; color: var(--muted); }
.legend .swatch { display: inline-block; width: 12px; height: 12px; vertical-align: -1px; border-radius: 2px; background: var(--odd); }
.cell { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; margin: 0 0 18px; }
.cell-body { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.shots { flex: 1 1 560px; min-width: 0; max-height: 72vh; overflow: auto; border: 1px solid var(--line); background: #0b0d10; }
.tiles { display: flex; gap: 8px; width: max-content; }
.tile figure { margin: 0; } .tile figcaption { color: var(--muted); font-size: 12px; padding: 4px 6px; }
.shots img { display: block; image-rendering: pixelated; }
.missing { padding: 24px; color: var(--bad); }
.facts { flex: 0 1 auto; min-width: 0; max-width: 100%; }
.table-scroll { overflow-x: auto; margin: 0 0 8px; }
table { border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding: 0 0 6px; }
th, td { border: 1px solid var(--line); padding: 3px 6px; white-space: nowrap; }
th { background: #232834; font-weight: 600; } th.group { text-align: center; }
td.num { text-align: right; } td.reading { color: var(--muted); } td.odd { background: var(--odd); color: #ffd9a0; font-weight: 600; }
td.unmeasured { color: var(--muted); font-style: italic; text-align: center; white-space: normal; width: 16em; min-width: 12em; }
.verdicts { list-style: none; padding: 0; margin: 4px 0 16px; }
.verdict { margin: 0 0 8px; }
.pill { display: inline-block; min-width: 64px; text-align: center; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; color: #0b0d10; background: var(--muted); }
.v-passed .pill { background: var(--ok); } .v-declared .pill { background: var(--warn); }
.v-failed .pill, .v-flaky .pill, .v-expected-fail .pill { background: var(--bad); }
.title { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 12.5px; }
.tag { margin-left: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--warn); }
.fixed-by { margin: 4px 0 0 72px; color: var(--muted); white-space: pre-wrap; }
.message { margin: 6px 0 0; padding: 8px 10px; background: #0b0d10; border: 1px solid var(--line); border-radius: 4px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.empty { color: var(--muted); font-style: italic; }
.boot-meta { color: var(--muted); margin: -6px 0 12px; }
`;

function main(): void {
  const { tests, startTime } = readReport();
  const manifests = readManifests();
  let captures = 0;
  let missing = 0;
  const sections: string[] = [];

  for (const { dir, manifest } of manifests) {
    const boot = manifest.boot;
    const blocks: string[] = [];
    for (const group of cellsOf(manifest.entries)) {
      const cell = group[0].cell;
      const tiles = group.map((entry, i) => {
        captures += 1;
        const rel = entry.png.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..').join('/');
        const file = path.join(CAPTURE_ROOT, rel);
        const label = group.length > 1 ? `tile ${i}` : '';
        const cam = entry.camera ? `scale ${entry.camera.scale}` : '';
        const caption = [label, cam].filter((s) => s !== '').join(', ');
        if (rel !== entry.png || !existsSync(file)) {
          missing += 1;
          console.error(`capture-report: the capture ${entry.png} named in ${dir}/manifest.json is missing`);
          return `<div class="tile"><p class="missing">missing capture: ${esc(entry.png)}</p></div>`;
        }
        const size = pngSize(file);
        const dims = size === null ? '' : ` width="${size.width}" height="${size.height}"`;
        return `<div class="tile"><figure><img src="${esc(encodeURI(rel))}"${dims} alt="${esc(`capture ${rel}`)}"><figcaption>${esc(caption)}</figcaption></figure></div>`;
      });

      const properties = [...new Set(group.flatMap((e) => Object.keys(e.measurements ?? {})))];
      const facts = properties.map((property) => {
        const tables = group
          .map((entry, i) => {
            const rows = (entry.measurements?.[property] ?? []).filter(isObject);
            return propertyTable(rows, group.length > 1 ? `${property}, tile ${i}` : property);
          })
          .join('');
        return tables + verdictList(gradingTests(tests, property, group[0]), `No grading test for ${property} in this cell.`);
      });

      const scaleText = typeof cell.zoom === 'number' && zoomToken(group[0]) !== String(cell.zoom) ? ` (scale ${cell.zoom})` : '';
      const gl = group[0].gl;
      const glText = gl ? `, WebGL antialias ${String(gl.antialias)}, samples ${String(gl.samples)}` : '';
      blocks.push(
        `<section class="cell"><h3>zoom ${esc(zoomToken(group[0]))}${esc(scaleText)}${esc(glText)}</h3><div class="cell-body">` +
          `<div class="shots"><div class="tiles">${tiles.join('')}</div></div>` +
          `<div class="facts">${facts.join('') || '<p class="empty">No measurements in this capture.</p>'}</div>` +
          `</div></section>`,
      );
    }
    sections.push(
      `<h2>pixel ratio ${esc(boot.dpr)}, antialiasing ${esc(boot.aa)}</h2>` +
        `<div class="boot-meta">captures in <code>${esc(dir)}/</code></div>` +
        verdictList(captureTests(tests, boot), 'No capture test in the report for this boot.') +
        blocks.join(''),
    );
  }

  const unshown = tests.filter((t) => !t.shown);
  if (unshown.length > 0) {
    sections.push(`<h2>Tests not placed beside a capture</h2>${verdictList(unshown, '')}`);
  }

  const counts = (['passed', 'declared', 'failed', 'expected-fail', 'flaky', 'skipped', 'did-not-run'] as Verdict[])
    .map((v) => [v, tests.filter((t) => t.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${VERDICT_TEXT[v]}`)
    .join(', ');

  const rev = revision();
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Board captures ${esc(rev.slice(0, 12))}</title>
<style>${CSS}</style>
</head>
<body>
<h1>Board captures</h1>
<p class="meta">Revision <code>${esc(rev)}</code>, run started ${esc(startTime ?? 'at an unrecorded time')}. ${esc(captures)} captures; tests: ${esc(counts || 'none')}.</p>
<dl class="legend">
<dt>core, fringe, effective</dt><dd>Widths in device pixels of one outline side, the median over its sample lines. Core counts the pixels at or near full ink, fringe the partly covered pixels at its edges, and effective is the sum of every pixel's coverage (the thresholds are in <code>e2e-live/support/boardMeasure.ts</code>). lines is how many sample lines were read, skipped how many were refused.</dd>
<dt><span class="swatch"></span> tinted value</dt><dd>Differs from the most common value at that field among the row's other groups, for example one side against the other three.</dd>
<dt>not measured</dt><dd>No sample line on that side could be read; the reason follows.</dd>
<dt>declared</dt><dd>A grading test expected to fail on a known defect. It carries the tag of the requirement whose fix makes it pass, and the measured numbers that explain it.</dd>
</dl>
${sections.join('\n')}
</body>
</html>
`;
  writeFileSync(PAGE, html);
  if (missing > 0) console.error(`capture-report: ${missing} capture(s) named in a manifest are missing; the page marks each one`);
  console.log(`CAPTURE PAGE captures=${captures} path=${PAGE_SHOWN}`);
}

main();
