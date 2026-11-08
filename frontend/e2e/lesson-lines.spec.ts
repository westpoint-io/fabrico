import { test, expect, type Page } from '@playwright/test';
import { LESSONS } from '../src/tutorial/lessons/index';
import { noteTokens, type LessonNote } from '../src/tutorial/machine';
import { MAX_INSTRUCTION_CHARS, MAX_NOTE_CHARS, REAL_TABLES, phrase, type PhraseSegment } from '../src/tutorial/phrase';
import type { PhraseToken } from '../src/tutorial/types';
import { buildPacket, type InjectBelt } from './support/wire';
import {
  CARD,
  LINE_BELT_ID,
  SINK_ID,
  SOURCE_ID,
  boot,
  configuredHost,
  injectRefusal,
  placeBoth,
  readProbe,
  startLesson,
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
// fewer in the note slot, and every closing 4 lines or fewer on the finished card.

const SIZES = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;

const INSTRUCTION_LINES = 3;
const NOTE_LINES = 2;
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
    lesson.steps.flatMap((step) => step.stages.map((stage) => resolve(`${lesson.id} ${step.id}/${stage.id}`, stage.text))),
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
