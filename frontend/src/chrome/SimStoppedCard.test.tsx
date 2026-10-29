// @vitest-environment jsdom
//
// SimStoppedCard.test.tsx (FAIL-01, phase 90 D-12, 90-UI-SPEC 1.2 and 1.3) - the card a fatal
// sim error shows. jsdom for the same reason `LoadRefusedCard.test.tsx` gives: focus on mount,
// the copy label after a settled write, and the absence of every dismissal path are DOM
// behaviour, not tree shape.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHROME_CSS } from './chromeCss.ts';
import {
  DIALOG_BTN_INLINE_PADDING,
  SIM_STOPPED_COPY,
  SIM_STOPPED_COPY_LABELS,
  SIM_STOPPED_COPY_MAX_CH,
  SIM_STOPPED_COPY_MIN_WIDTH,
  SIM_STOPPED_REASON_MAX,
  SimStoppedCard,
  simStoppedDetails,
  visibleReason,
} from './SimStoppedCard.tsx';
import { COPY_RESULT_HOLD_MS } from './clipboardCopy.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
});

function render(reason: string | null, opts: { lastTick?: () => number; copy?: (t: string) => Promise<void> } = {}): void {
  act(() => {
    root.render(<SimStoppedCard reason={reason} lastTick={opts.lastTick ?? (() => 0)} copy={opts.copy ?? (() => Promise.resolve())} />);
  });
}

/** The dev host's reason today (`sim_fatal.rs` over the injected `StoreError`). */
const DEV_REASON =
  'sim loop terminated with a fatal store error: persistence backend error: dev fault injected by dev_render_server';

function reasonText(): string | null {
  return document.querySelector('[data-fab-sim-stopped-reason]')?.textContent ?? null;
}

function copyButton(): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>('[data-fab-sim-stopped-copy]');
  expect(b, 'the card carries the Copy details button').not.toBeNull();
  return b as HTMLButtonElement;
}

/** Let the copy machine's awaited write and its `.then` run. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

describe('SimStoppedCard', () => {
  it('the_card_renders_nothing_while_the_sim_runs', () => {
    render(null);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(container.innerHTML).toBe('');
  });

  it('the_card_says_what_happened_why_and_what_it_means_with_one_button', () => {
    render(DEV_REASON);
    const alerts = document.querySelectorAll<HTMLElement>('[role="alert"]');
    expect(alerts).toHaveLength(1);
    const alert = alerts[0]!;
    // Labelled by its heading.
    const heading = alert.querySelector('h2');
    expect(heading?.textContent).toBe(SIM_STOPPED_COPY.heading);
    expect(alert.getAttribute('aria-labelledby')).toBe(heading?.id);
    expect(heading?.className).toBe('fab-title');
    // The glyph, the reason, the consequence, in that DOM order.
    expect(alert.querySelector('svg'), 'the warning glyph').not.toBeNull();
    expect(reasonText()).toBe(DEV_REASON);
    const paragraphs = Array.from(alert.querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs).toEqual([DEV_REASON, SIM_STOPPED_COPY.consequence]);
    // One button and no other: no Close, nothing that claims to bring the sim back.
    const buttons = Array.from(alert.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toEqual([SIM_STOPPED_COPY.copy]);
    // Not a modal, no scrim, no timer that clears it.
    expect(document.querySelectorAll('.fab-dialog-scrim')).toHaveLength(0);
    expect(alert.style.position).toBe('fixed');
    expect(alert.style.zIndex).toBe('6');
    expect(alert.className).toBe('fab-panel');
    const reasonEl = alert.querySelector<HTMLElement>('[data-fab-sim-stopped-reason]');
    expect(reasonEl?.style.overflowWrap).toBe('anywhere');
  });

  it('the_copy_record_is_pinned_as_data', () => {
    expect(SIM_STOPPED_COPY).toEqual({
      heading: 'The simulation stopped.',
      consequence: 'This board can no longer run, change or be saved. To keep working, close Fabrico and open it again.',
      copy: 'Copy details',
      disabledTitle: 'Unavailable: the simulation stopped',
    });
  });

  // Plan 90-08 walk (WebKitGTK): the button narrowed by its padding on every press. A `<button>`
  // is border-box, so the reserve must hold the longest label AND both inline paddings; a bare
  // `12ch` is the shape that moved it.
  it('the_copy_button_reserves_its_longest_label_plus_its_padding_so_a_press_never_moves_it', () => {
    const rule = CHROME_CSS.match(/\.fab-dialog-btn \{([^}]*)\}/);
    expect(rule, 'chromeCss.ts declares .fab-dialog-btn').not.toBeNull();
    const padding = rule?.[1].match(/padding:\s*([^;]+);/)?.[1].trim() ?? '';
    expect(padding, 'the inline padding the reserve adds is the stylesheet\'s own').toBe(
      `var(--fab-bezel-ring) ${DIALOG_BTN_INLINE_PADDING}`,
    );
    expect(SIM_STOPPED_COPY_MAX_CH).toBe(Math.max(...Object.values(SIM_STOPPED_COPY_LABELS).map((l) => l.length)));
    expect(SIM_STOPPED_COPY_MAX_CH, 'the idle word is the longest label').toBe(SIM_STOPPED_COPY.copy.length);
    expect(SIM_STOPPED_COPY_MIN_WIDTH).toBe(`calc(${SIM_STOPPED_COPY_MAX_CH}ch + 2 * ${DIALOG_BTN_INLINE_PADDING})`);
    render(DEV_REASON);
    const declared = copyButton().getAttribute('style') ?? '';
    expect(declared, 'the button carries the padded reserve, not a bare ch width').toContain(
      `min-width: ${SIM_STOPPED_COPY_MIN_WIDTH}`,
    );
  });

  it('a_click_outside_and_escape_leave_the_card_in_place', () => {
    render(DEV_REASON);
    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
  });

  it('focus_moves_to_copy_details_on_mount', () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);
    render(DEV_REASON);
    expect(document.activeElement).toBe(copyButton());
    before.remove();
  });

  // Review WR-B-08: an open quit guard is a modal over a scrim; the card mounting behind it must
  // not take its focus (Enter would then copy details instead of answering the dialog).
  it('focus_stays_in_an_open_dialog_when_the_card_mounts', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'alertdialog');
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    dialog.appendChild(cancel);
    document.body.appendChild(dialog);
    try {
      cancel.focus();
      expect(document.activeElement).toBe(cancel);
      render(DEV_REASON);
      expect(document.activeElement, 'the dialog keeps the keyboard').toBe(cancel);
    } finally {
      dialog.remove();
    }
  });

  // Review IN-B-01: the focused button names only its action, so it points at the heading and the
  // reason, and a screen reader that reads only the focused control still hears why.
  it('the_copy_button_is_described_by_the_heading_and_the_reason', () => {
    render(DEV_REASON);
    const button = document.querySelector('[data-fab-sim-stopped-copy]') as HTMLButtonElement;
    const ids = (button.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x !== '');
    expect(ids.length, 'the button names what describes it').toBeGreaterThan(0);
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(text).toContain(SIM_STOPPED_COPY.heading);
    expect(text).toContain(visibleReason(DEV_REASON));
  });

  it('a_long_reason_shows_its_first_239_code_points_and_an_ellipsis', () => {
    const long = 'x'.repeat(300);
    render(long);
    const shown = reasonText() ?? '';
    expect(Array.from(shown)).toHaveLength(SIM_STOPPED_REASON_MAX);
    expect(shown).toBe(`${'x'.repeat(239)}…`);
    // Exactly the cap shows whole, with no ellipsis.
    expect(visibleReason('y'.repeat(240))).toBe('y'.repeat(240));
  });

  it('a_multi_line_reason_shows_its_first_line', () => {
    render('sim thread panicked: index out of bounds\n   at core::step\n   at sim::run');
    expect(reasonText()).toBe('sim thread panicked: index out of bounds');
    expect(visibleReason('first\r\nsecond')).toBe('first');
  });

  it('a_cut_never_splits_a_surrogate_pair', () => {
    // 238 ASCII then emoji, each one code point and two UTF-16 units: a cut by UTF-16 length
    // would land inside the third emoji's pair.
    const reason = `${'a'.repeat(238)}\u{1F525}\u{1F525}\u{1F525}\u{1F525}`;
    render(reason);
    const shown = reasonText() ?? '';
    expect(shown).toBe(`${'a'.repeat(238)}\u{1F525}…`);
    // No lone surrogate anywhere in what is shown.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(shown)).toBe(false);
  });

  it('an_empty_reason_still_shows_the_heading_and_the_consequence', () => {
    render('');
    const alert = document.querySelector('[role="alert"]');
    expect(alert, 'an empty reason still mounts the card').not.toBeNull();
    expect(alert?.querySelector('h2')?.textContent).toBe(SIM_STOPPED_COPY.heading);
    expect(alert?.textContent).toContain(SIM_STOPPED_COPY.consequence);
    expect(reasonText()).toBeNull();
  });

  it('a_reason_holding_markup_is_shown_as_text', () => {
    render('sim thread panicked: <b>x</b>');
    expect(reasonText()).toBe('sim thread panicked: <b>x</b>');
    expect(document.querySelector('[data-fab-sim-stopped-reason] b')).toBeNull();
  });

  it('copy_details_writes_three_lines_with_the_full_reason_and_says_copied_only_after_the_write', async () => {
    vi.useFakeTimers();
    let resolveWrite: () => void = () => {};
    const written: string[] = [];
    const copy = vi.fn((t: string) => {
      written.push(t);
      return new Promise<void>((r) => {
        resolveWrite = r;
      });
    });
    const full = `first line\nsecond line ${'z'.repeat(300)}`;
    render(full, { lastTick: () => 18342, copy });
    act(() => copyButton().click());
    expect(copy).toHaveBeenCalledTimes(1);
    expect(written[0]).toBe(`The simulation stopped.\nReason: ${full}\nLast tick shown: 18342`);
    expect(written[0]).toBe(simStoppedDetails(full, 18342));
    expect(written[0]?.endsWith('\n')).toBe(false);
    // In flight: the idle word, busy and aria-disabled, never the real disabled attribute.
    await settle();
    expect(copyButton().textContent).toBe('Copy details');
    expect(copyButton().getAttribute('aria-busy')).toBe('true');
    expect(copyButton().getAttribute('aria-disabled')).toBe('true');
    expect(copyButton().disabled).toBe(false);
    expect(copyButton().getAttribute('aria-live')).toBe('off');
    // The write resolves: `Copied`, announced politely, then back after the hold.
    resolveWrite();
    await settle();
    expect(copyButton().textContent).toBe('Copied');
    expect(copyButton().getAttribute('aria-live')).toBe('polite');
    act(() => {
      vi.advanceTimersByTime(COPY_RESULT_HOLD_MS);
    });
    expect(copyButton().textContent).toBe('Copy details');
    expect(copyButton().getAttribute('aria-live')).toBe('off');
  });

  it('a_rejected_or_absent_clipboard_reads_copy_failed_never_copied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(DEV_REASON, { copy: () => Promise.reject(new Error('NotAllowedError')) });
    act(() => copyButton().click());
    await settle();
    expect(copyButton().textContent).toBe('Copy failed');
    vi.restoreAllMocks();
  });

  it('the_tick_on_the_clipboard_is_read_when_the_button_is_pressed', async () => {
    let tick = 5;
    const written: string[] = [];
    render(DEV_REASON, {
      lastTick: () => tick,
      copy: (t) => {
        written.push(t);
        return Promise.resolve();
      },
    });
    tick = 77;
    act(() => copyButton().click());
    await settle();
    expect(written[0]?.split('\n')[2]).toBe('Last tick shown: 77');
  });
});
