import { test, expect, type Page } from '@playwright/test';
import { LESSONS } from '../src/tutorial/lessons/index';
import { noteTokens, type LessonNote } from '../src/tutorial/machine';
import { MAX_INSTRUCTION_CHARS, MAX_NOTE_CHARS, REAL_TABLES, phrase, splitAtBlock, type PhraseSegment } from '../src/tutorial/phrase';
import type { PhraseToken } from '../src/tutorial/types';
import { buildPacket, type InjectBelt } from './support/wire';
import { requestLineText } from '../src/tutorial/request';
import {
  CARD,
  LINE_BELT_ID,
  REQUEST_STAGE,
  REQUEST_STEP,
  SINK_ID,
  SOURCE_ID,
  boot,
  configuredHost,
  emptyFloor,
  expectAt,
  injectRefusal,
  placeBoth,
  pressRing,
  readProbe,
  requestHost,
  ringAt,
  routeConfig,
  selectRoute,
  startLesson,
  toAnswerStep,
  toBeltDraw,
} from './support/lessonMock';

// lesson-lines.spec.ts - every lesson text fits the step card's real column (UI-SPEC "The three-line check").
//
// The character budgets in phrase.ts (141 for an instruction, 94 for a note) assume 47 characters a
// line at Martian Mono's 8 px advance. Word breaks lose a few characters a line, so a 141-character
// sentence of long words can set 4 lines, and only the browser knows where a line breaks. This spec
// boots the mock host at 1280x720 and 1024x768, starts lesson 1 so a running card is on screen with its
// real font, width and padding, and then sets each text into the card's own paragraph. It builds the
// paragraph's children the way `Words` in StepCard.tsx does (StepCard.test.tsx pins that markup), reads
// the paragraph's height over its computed line height, and puts the card's own words back.
//
// The list comes from LESSONS, so a new stage, coaching line or closing is measured with no edit here:
// every stage instruction must set 3 lines or fewer, every coaching line and lesson note 2 lines or
// fewer in the note slot, and every closing 4 lines or fewer on the finished card. A stage holding the
// request line's block token is two paragraphs on the card, cut by `splitAtBlock`: the part before it is
// the instruction, measured as one, and the part after it is the line under the request line, held to 2
// lines. Both set in the card's text column with the same style.
//
// The request line itself is measured on lesson 5's real send-request card, as React renders it from the
// URL the mock host answers, because its box, its clamp and its break points are the card's own. Three
// URLs (the default, a 5-digit port with a 60-character path, and a 1024-byte path, the longest a Route
// takes) each set with `curl` under a Linux user agent and `curl.exe` under a Windows one, at both window
// sizes. The line must set 3 lines or fewer with the instruction above it at 3 or fewer and the line
// under it at 2 or fewer, and its textContent must stay the whole line however it is cut.

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;

const INSTRUCTION_LINES = 3;
const NOTE_LINES = 2;
/** The line under the request line, in the same column as the instruction. */
const AFTER_LINES = 2;
const CLOSING_LINES = 4;

/** Two-digit step numbers, the widest a lesson note prints. */
const NOTES: Readonly<Record<LessonNote['kind'], LessonNote>> = {
  skippedOne: { kind: 'skippedOne', a: 99, b: 99 },
  skippedMany: { kind: 'skippedMany', a: 99, b: 99 },
  wentBack: { kind: 'wentBack', a: 99, b: 99 },
  alreadyRunning: { kind: 'alreadyRunning', a: 99, b: 99 },
};

interface Text {
  /** `<lesson> <step>/<stage>`, or the note or closing it is. */
  where: string;
  segments: PhraseSegment[];
}

interface Measured {
  where: string;
  lines: number;
  chars: number;
}

const resolve = (where: string, tokens: readonly PhraseToken[]): Text => ({ where, segments: phrase(tokens, REAL_TABLES) });

function instructions(): Text[] {
  return LESSONS.flatMap((lesson) =>
    lesson.steps.flatMap((step) => step.stages.map((stage) => resolve(`${lesson.id} ${step.id}/${stage.id}`, splitAtBlock(stage.text).before))),
  );
}

/** The line under the request line, for each stage that has one. */
function afters(): Text[] {
  return LESSONS.flatMap((lesson) =>
    lesson.steps.flatMap((step) =>
      step.stages.flatMap((stage) => {
        const { after } = splitAtBlock(stage.text);
        return after.length === 0 ? [] : [resolve(`${lesson.id} ${step.id}/${stage.id} after`, after)];
      }),
    ),
  );
}

function notes(): Text[] {
  const coaching = LESSONS.flatMap((lesson) =>
    lesson.steps.flatMap((step) =>
      step.stages.flatMap((stage) =>
        Object.entries(stage.coach ?? {}).map(([tag, tokens]) => resolve(`${lesson.id} ${step.id}/${stage.id} coach=${tag}`, tokens)),
      ),
    ),
  );
  const lessonNotes = Object.values(NOTES).map((note) => resolve(`note ${note.kind}`, noteTokens(note)));
  return [...coaching, ...lessonNotes];
}

function closings(): Text[] {
  return LESSONS.map((lesson) => resolve(`${lesson.id} closing`, lesson.closing));
}

/**
 * Set each text into the paragraph `selector` names and read its line count, in one synchronous run
 * so no React render lands between the swap and the restore. The paragraph keeps its own style; its
 * children are built as `Words` builds them: a plain segment is a text node, a token a span at weight
 * 700, a code fragment a span at weight 700 that doesn't wrap, marked `data-fab-code`.
 */
async function measure(page: Page, selector: string, texts: Text[]): Promise<Measured[]> {
  return page.locator(selector).evaluate((p, list: Text[]) => {
    const own = Array.from(p.childNodes);
    const out: Measured[] = [];
    try {
      for (const text of list) {
        const children = text.segments.map((segment): Node => {
          if (!segment.strong) return document.createTextNode(segment.text);
          const span = document.createElement('span');
          span.style.fontWeight = '700';
          if (segment.code === true) {
            span.style.whiteSpace = 'nowrap';
            span.setAttribute('data-fab-code', '');
          }
          span.textContent = segment.text;
          return span;
        });
        p.replaceChildren(...children);
        const lines = Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight));
        out.push({ where: text.where, lines, chars: (p.textContent ?? '').length });
      }
    } finally {
      p.replaceChildren(...own);
    }
    return out;
  }, texts);
}

function check(size: string, measured: Measured[], limit: number, what: string): void {
  for (const m of measured) {
    console.log(`MEASURE lines ${size} ${m.where} lines=${m.lines} chars=${m.chars}`);
  }
  for (const m of measured) {
    expect(m.lines, `${size} ${m.where}: the ${what} sets ${m.lines} lines, over ${limit}`).toBeLessThanOrEqual(limit);
  }
}

/** Lesson 1 from the belt draw to the finished card, with the host's packets injected as lessons.spec.ts does. */
async function finishLessonOne(page: Page, h: Awaited<ReturnType<typeof boot>>, host: ReturnType<typeof configuredHost>): Promise<void> {
  const { source, sink, tick } = await placeBoth(page, h);
  await toBeltDraw(page, host);
  const belt = (itemSlots: number[]): InjectBelt => ({
    id: LINE_BELT_ID,
    tiles: [
      [source.cell_x + 1, source.cell_y],
      [source.cell_x + 2, source.cell_y],
    ],
    itemSlots,
    docks: [
      { end: 'Tail', node: SOURCE_ID, port: 0 },
      { end: 'Head', node: SINK_ID, port: 0 },
    ],
  });
  const at = (t: number, itemSlots: number[]): Buffer =>
    buildPacket({ full: false, tick: t, generation: 1, swapFloor: 1, nodes: [source, sink], belts: [belt(itemSlots)] });
  h.inject(at(tick + 1, []));
  await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the belt finished draw-belt' }).toBe('board-running');
  h.inject(at(tick + 2, [5]));
  await expect.poll(async () => (await readProbe(page)).stageId, { message: 'the higher tick finished press-play' }).toBe('watch');
  h.inject(at(tick + 3, [0]));
  h.inject(at(tick + 4, []));
  await expect.poll(async () => (await readProbe(page)).card, { message: 'the delivery finished the lesson' }).toBe('finished');
}

test.describe('every lesson text fits the step card column', () => {
  test('the budgets stay 141 and 94', () => {
    expect(MAX_INSTRUCTION_CHARS).toBe(141);
    expect(MAX_NOTE_CHARS).toBe(94);
  });

  for (const viewport of SIZES) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`at ${size}: instructions 3 lines, notes 2, closings 4`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const host = configuredHost();
      const h = await boot(page, host.opts);
      await startLesson(page, h);
      const card = page.locator(CARD);
      const textBefore = await card.locator('[data-fab-step-text]').textContent();

      const instructionList = instructions();
      const measuredInstructions = await measure(page, `${CARD} [data-fab-step-text]`, instructionList);
      expect(measuredInstructions).toHaveLength(instructionList.length);
      check(size, measuredInstructions, INSTRUCTION_LINES, 'instruction');
      for (const stage of ['type-code', 'watch']) {
        expect(
          measuredInstructions.some((m) => m.where === `a-factory-with-two-outputs change-code/${stage}`),
          `lesson 4's ${stage} stage is measured`,
        ).toBe(true);
      }
      const afterList = afters();
      expect(afterList.map((t) => t.where), 'the line under the request line is measured').toContain('answer-a-web-request answer/send-request after');
      const measuredAfters = await measure(page, `${CARD} [data-fab-step-text]`, afterList);
      expect(measuredAfters).toHaveLength(afterList.length);
      check(size, measuredAfters, AFTER_LINES, 'line after the request line');
      await expect(card.locator('[data-fab-step-text]'), "the card's own words are back").toHaveText(textBefore ?? '');

      // A refusal opens the note slot, so its paragraph is on the card to set the notes into.
      injectRefusal(h, 'InvalidDock');
      await expect.poll(async () => (await readProbe(page)).noteKind, { message: 'a refusal opened the note slot' }).toBe('refusal');
      const noteList = notes();
      const measuredNotes = await measure(page, `${CARD} [data-fab-step-note] p`, noteList);
      expect(measuredNotes).toHaveLength(noteList.length);
      check(size, measuredNotes, NOTE_LINES, 'note');

      await finishLessonOne(page, h, host);
      await expect(card.getByRole('heading', { name: 'Lesson done' })).toBeVisible();
      const closing = card.locator('[aria-live] > p');
      await expect(closing).toHaveCount(1);
      const closingBefore = await closing.textContent();
      const measuredClosings = await measure(page, `${CARD} [aria-live] > p`, closings());
      expect(measuredClosings).toHaveLength(LESSONS.length);
      check(size, measuredClosings, CLOSING_LINES, 'closing');
      await expect(closing, "the finished card's own words are back").toHaveText(closingBefore ?? '');
    });
  }
});

/** The request line's own budget, set by its clamp. */
const REQUEST_LINES = 3;

/** A user agent for each curl word: a Linux Chromium for `curl`, a Windows 10 Chromium for `curl.exe`. */
const AGENTS = [
  { word: 'curl', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
  { word: 'curl.exe', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
] as const;

/** The longest Route path the host takes, in bytes (`MAX_ENDPOINT_PATH_BYTES`). */
const MAX_PATH_BYTES = 1024;

/** A path of exactly `length` bytes, the leading slash included, cut from `fill`. */
function pathOf(length: number, fill: string): string {
  return `/${fill.repeat(Math.ceil(length / fill.length)).slice(0, length - 1)}`;
}

/** The three URLs: the default, a 5-digit port with a 60-character path of segments, and a 1024-byte path. */
const URL_CASES = [
  { name: 'default', url: 'http://127.0.0.1:54321/endpoint/route-12', path: '/route-12' },
  { name: 'port5-path60', url: `http://127.0.0.1:65535/endpoint${pathOf(60, 'orders/2026/')}`, path: pathOf(60, 'orders/2026/') },
  { name: 'path1024', url: `http://127.0.0.1:65535/endpoint${pathOf(MAX_PATH_BYTES, 'route-1234567890')}`, path: pathOf(MAX_PATH_BYTES, 'route-1234567890') },
] as const;

interface LineRead {
  /** Lines the box shows: its content height over its line height. */
  lines: number;
  chars: number;
  text: string;
  /** Is any of the text cut off below the box? */
  clipped: boolean;
  /** The line, from 0, the URL's first character sets on. */
  urlLine: number;
  /** For each line break among the lines shown, the character before it. */
  breaks: string[];
  /** The instruction's and the after line's lines on the same card. */
  instruction: number;
  after: number;
}

/** The card's request line, instruction and after line, read in one evaluate. */
async function readRequestCard(page: Page, urlAt: number): Promise<LineRead> {
  return page.locator(CARD).evaluate((card, at) => {
    const linesOf = (el: Element | null): number => {
      if (!(el instanceof HTMLElement)) return -1;
      const cs = getComputedStyle(el);
      const content = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return Math.round(content / parseFloat(cs.lineHeight));
    };
    const box = card.querySelector('[data-fab-request-line]');
    if (!(box instanceof HTMLElement)) throw new Error('the card shows no request line');
    const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
    const lines = linesOf(box);
    const boxTop = box.getBoundingClientRect().top + parseFloat(getComputedStyle(box).paddingTop) + parseFloat(getComputedStyle(box).borderTopWidth);
    // Each character's line, read off a one-character range's rect.
    const chars: { ch: string; line: number }[] = [];
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const value = node.textContent ?? '';
      for (let i = 0; i < value.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rects = range.getClientRects();
        const top = rects.length > 0 ? rects[rects.length - 1].top : range.getBoundingClientRect().top;
        chars.push({ ch: value[i], line: Math.round((top - boxTop) / lineHeight) });
      }
    }
    const breaks: string[] = [];
    for (let i = 1; i < chars.length; i++) {
      if (chars[i].line > chars[i - 1].line && chars[i].line < lines) breaks.push(chars[i - 1].ch);
    }
    return {
      lines,
      chars: (box.textContent ?? '').length,
      text: box.textContent ?? '',
      clipped: box.scrollHeight > box.clientHeight + 1,
      urlLine: chars[at]?.line ?? -1,
      breaks,
      instruction: linesOf(card.querySelector('[data-fab-step-text]')),
      after: linesOf(card.querySelector('[data-fab-step-after]')),
    };
  }, urlAt);
}

for (const agent of AGENTS) {
  test.describe(`the request line fits the card column with ${agent.word}`, () => {
    test.use({ userAgent: agent.userAgent });

    for (const viewport of SIZES) {
      const size = `${viewport.width}x${viewport.height}`;
      test(`at ${size}: the request line sets 3 lines or fewer for each URL, with ${agent.word}`, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(viewport);
        const host = requestHost(URL_CASES[0].url);
        const { board } = await toAnswerStep(page, host, { path: URL_CASES[0].path });
        await selectRoute(page);
        await ringAt(page, REQUEST_STAGE.sendRequest);
        for (const [i, c] of URL_CASES.entries()) {
          const whole = requestLineText(agent.word, c.url);
          if (i > 0) {
            // The host answers the new URL from now on; deselect and select the Route so the row asks again.
            host.set(board.route.id, routeConfig(c.path));
            host.setUrl(c.url);
            const floor = await emptyFloor(page, board.route);
            await page.mouse.click(floor.x, floor.y);
            await expectAt(page, REQUEST_STEP.answer, REQUEST_STAGE.selectRoute, `${c.name}: a press on the empty floor deselected the Route`);
            await pressRing(page, await ringAt(page, REQUEST_STAGE.selectRoute));
            await ringAt(page, REQUEST_STAGE.sendRequest);
          }
          await expect
            .poll(async () => (await page.locator(`${CARD} [data-fab-request-line]`).textContent()) ?? '', {
              message: `${size} ${c.name}: the card shows the ${agent.word} line for the URL the host answered`,
            })
            .toBe(whole);
          // Soft checks, so a case that fails doesn't hide the cases after it.
          const read = await readRequestCard(page, `${agent.word} -X POST `.length);
          const where = `request-line ${c.name} ${agent.word}`;
          console.log(`MEASURE lines ${size} ${where} lines=${read.lines} chars=${read.chars} url_line=${read.urlLine} breaks=${JSON.stringify(read.breaks.join(''))} clipped=${read.clipped}`);
          console.log(`MEASURE lines ${size} ${where} instruction lines=${read.instruction} after lines=${read.after}`);
          expect.soft(read.text, `${size} ${where}: textContent holds the whole line`).toBe(whole);
          expect.soft(read.lines, `${size} ${where}: the request line sets ${read.lines} lines, over ${REQUEST_LINES}`).toBeLessThanOrEqual(REQUEST_LINES);
          expect.soft(read.instruction, `${size} ${where}: the instruction above it sets ${read.instruction} lines`).toBeLessThanOrEqual(INSTRUCTION_LINES);
          expect.soft(read.instruction, `${size} ${where}: the instruction is on the card`).toBeGreaterThan(0);
          expect.soft(read.after, `${size} ${where}: the line under it sets ${read.after} lines`).toBeLessThanOrEqual(AFTER_LINES);
          expect.soft(read.after, `${size} ${where}: the line under it is on the card`).toBeGreaterThan(0);
          if (c.name === 'default') {
            expect.soft(read.lines, `${size} ${where}: the default line sets two lines`).toBe(2);
            expect.soft(read.urlLine, `${size} ${where}: the command sets on line 1 and the URL on line 2`).toBe(1);
          }
          if (c.name !== 'path1024') expect.soft(read.clipped, `${size} ${where}: the whole line shows, with nothing cut off`).toBe(false);
          if (c.name === 'port5-path60') {
            for (const ch of read.breaks) expect.soft([' ', '/'], `${size} ${where}: each line ends at the space or a slash, never mid-word`).toContain(ch);
          }
          if (c.name === 'path1024') {
            expect.soft(read.lines, `${size} ${where}: the 1024-byte path shows exactly 3 lines`).toBe(REQUEST_LINES);
            expect.soft(read.clipped, `${size} ${where}: the rest of the path is cut off under the third line`).toBe(true);
            const clamp = await page.locator(`${CARD} [data-fab-request-line]`).evaluate((el) => getComputedStyle(el).webkitLineClamp);
            expect.soft(clamp, `${size} ${where}: the third line ends in the clamp's ellipsis`).toBe(String(REQUEST_LINES));
          }
        }
      });
    }
  });
}
