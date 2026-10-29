// SimStoppedCard.tsx (FAIL-01, phase 90 D-12, 90-UI-SPEC section 1) - the card a fatal sim
// error shows: the simulation stopped, the host's reason, what that means, and one way to copy
// the details.
//
// # What this exists to end
// When the host's sim loop ended on a fatal error, plan 90-06 made the status line say
// `Simulation stopped` and dimmed the board. That says THAT it stopped, never WHY, and the status
// line must never carry the host's sentence (T-32-06-01). So the host's reason is shown here, in
// the one alert node the stopped board owns, and nowhere else.
//
// # Why this is NOT a mode of `LoadRefusedCard` (UI-SPEC A1)
// That card is dismissable and says "Your board has not changed.", both wrong here: the board
// can no longer change at all, and a dismissed card would leave a dimmed board with no reason on
// it. The two share the viewport-centre slot and zIndex 6 (A2): App renders this one INSTEAD of
// the load card while a reason is held, so they never overlap.
//
// # Not dismissable and not a modal (D-12)
// No Close, no scrim, no key listener, no auto-clear. And no action that claims to bring the
// sim back: the app has none, and a button that offered one would be a lie. The consequence sentence names
// the one path that always works (close the app and open it again), as text. No focus trap: Tab
// leaves the card for the controls that still work (Help, the camera, the Legend).
//
// Styling reads `--fab-*` tokens only and the bezel is the registered `.fab-panel` class, the
// `LoadRefusedCard` discipline (see its header): no inline ring, so the stylesheet's derived
// ring-carrier set does not move.

import { useEffect, useRef, useState, type JSX } from 'react';
import { WarningIcon } from './icons';
import { COPY_LABELS } from './WebhookUrlRow.tsx';
import { clipboardCopy, makeCopyMachine, type CopyMachine, type CopyState } from './clipboardCopy.ts';

/**
 * The CLIENT-AUTHORED copy, exported as data so the vitest suite pins it (the
 * `LOAD_REFUSED_COPY` idiom). The reason is NOT in here: it is the host's own sentence, shown
 * verbatim. `disabledTitle` is the `title` every control that would send to the stopped host
 * carries while stopped (UI-SPEC 1.4).
 */
export const SIM_STOPPED_COPY: Record<'heading' | 'consequence' | 'copy' | 'disabledTitle', string> = {
  heading: 'The simulation stopped.',
  consequence: 'This board can no longer run, change or be saved. To keep working, close Fabrico and open it again.',
  copy: 'Copy details',
  disabledTitle: 'Unavailable: the simulation stopped',
};

/** The button's whole vocabulary: its own idle word, then the shipped copy results
 *  (`COPY_LABELS`), so the app keeps one copy vocabulary. The in-flight state holds the idle
 *  word: nothing has happened yet (the `WebhookUrlRow` rule). */
export const SIM_STOPPED_COPY_LABELS: Record<CopyState, string> = {
  idle: SIM_STOPPED_COPY.copy,
  copying: SIM_STOPPED_COPY.copy,
  copied: COPY_LABELS.copied,
  failed: COPY_LABELS.failed,
};

/** The longest label in `ch`, derived from its label set (the `COPY_LABEL_MAX_CH` idiom): one
 *  `ch` is one Martian Mono advance. */
export const SIM_STOPPED_COPY_MAX_CH = Math.max(...Object.values(SIM_STOPPED_COPY_LABELS).map((l) => l.length));

/** `.fab-dialog-btn`'s inline (left and right) padding, as `chromeCss.ts` declares it. */
export const DIALOG_BTN_INLINE_PADDING = 'calc(var(--fab-space-md) + var(--fab-bezel-ring))';

/**
 * The button's reserved width. A `<button>` is border-box by UA default, so a bare
 * `min-width: 12ch` held the padding too: the idle word (12 characters, the longest) overflowed
 * it and set the width, `Copied` fell back to the bare 12ch, and the button narrowed by its
 * padding on every press (seen on the plan 90-08 walk, WebKitGTK). The reserve is the longest
 * label plus both inline paddings, so every label sits in the same box and the swap never moves
 * the button.
 */
export const SIM_STOPPED_COPY_MIN_WIDTH = `calc(${SIM_STOPPED_COPY_MAX_CH}ch + 2 * ${DIALOG_BTN_INLINE_PADDING})`;

/** The most code points the visible reason shows (UI-SPEC A10): about five lines at 420px. */
export const SIM_STOPPED_REASON_MAX = 240;

/**
 * The reason as the card shows it: the first line only, and at most `SIM_STOPPED_REASON_MAX`
 * code points, cut to one fewer with `…` appended when longer. Counted with `Array.from`, so a
 * cut never splits a surrogate pair. The clipboard gets the full reason, never this.
 */
export function visibleReason(reason: string): string {
  const firstLine = reason.split(/\r?\n/, 1)[0] ?? '';
  const points = Array.from(firstLine);
  if (points.length <= SIM_STOPPED_REASON_MAX) return firstLine;
  return `${points.slice(0, SIM_STOPPED_REASON_MAX - 1).join('')}…`;
}

/** The clipboard text (UI-SPEC 1.3): three lines joined by `\n`, no trailing newline, the FULL
 *  reason, and the tick the board last drew as a plain integer. */
export function simStoppedDetails(reason: string, lastTick: number): string {
  return [SIM_STOPPED_COPY.heading, `Reason: ${reason}`, `Last tick shown: ${String(lastTick)}`].join('\n');
}

export interface SimStoppedCardProps {
  /** The host's reason once its sim loop has ended, or `null` while it runs. */
  reason: string | null;
  /** The tick the board last drew, read at the moment Copy details is pressed. */
  lastTick: () => number;
  /** The clipboard writer, injectable so both outcomes are testable (the `WebhookUrlRow` seam).
   *  The default is the shipped env-branched writer. */
  copy?: (text: string) => Promise<void>;
}

export function SimStoppedCard({ reason, lastTick, copy = clipboardCopy }: SimStoppedCardProps): JSX.Element | null {
  const open = reason !== null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // The current writer through a ref, so the one machine below keeps its guards across renders.
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);
  const machineRef = useRef<CopyMachine | null>(null);

  // Focus moves to Copy details on mount (UI-SPEC A5): it is the card's one control, it is not
  // destructive, and it rescues focus from a control that just went disabled or a panel that
  // just closed. It is never returned anywhere, because the card never closes. Review WR-B-08:
  // except from a dialog. App leaves an open quit guard open on a fatal (its words are true), and
  // the guard is a modal over a scrim, so focus taken from it would land behind the scrim: Enter
  // would copy details instead of answering the dialog, and Escape and Tab would leave it.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[role="alertdialog"],[role="dialog"]') !== null) return;
    buttonRef.current?.focus();
  }, [open]);

  // Unmount disposes the machine: its hold timer is cancelled and a write still in flight lands
  // on nothing (the `WebhookUrlRow` cleanup).
  useEffect(
    () => () => {
      machineRef.current?.dispose();
      machineRef.current = null;
    },
    [],
  );

  if (reason === null) {
    // CONDITIONAL MOUNT: at rest this adds no `role="alert"` node to the page.
    return null;
  }

  const shown = visibleReason(reason);
  const inFlight = copyState === 'copying';
  const hasResult = copyState === 'copied' || copyState === 'failed';

  const onCopy = (): void => {
    if (machineRef.current === null) {
      machineRef.current = makeCopyMachine({
        copy: (text) => copyRef.current(text),
        setState: setCopyState,
      });
    }
    machineRef.current.click(simStoppedDetails(reason, lastTick()));
  };

  const paragraph = {
    margin: 0,
    fontFamily: 'var(--fab-font)',
    fontSize: 'var(--fab-font-size-base)',
    // `.fab-panel` sets `line-height: 1`, wrong for a paragraph that wraps.
    lineHeight: 1.4,
    // Ink, never `--fab-destructive`: ink is 5.16:1 on the panel fill, destructive 2.92:1.
    color: 'var(--fab-ink)',
  } as const;

  return (
    <div
      role="alert"
      aria-labelledby="fab-sim-stopped-heading"
      data-fab-sim-stopped=""
      className="fab-panel"
      style={{
        position: 'fixed',
        // The `LoadRefusedCard` slot: the viewport centre, zIndex 6 (above the refusal band at
        // 5, below the dialog scrim at 1000, so the quit guard opens over this card).
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--fab-space-md)',
        padding: 'calc(var(--fab-space-md) + var(--fab-bezel-ring))',
        maxWidth: '420px',
        // The card owns a button; it never covers the viewport, so the board around it still
        // takes the pan and the wheel.
        pointerEvents: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-sm)' }}>
        {/* BARE, no size prop (the icon ladder gate reddens on one). Decorative and redundant
            (`aria-hidden` at source): the words carry the meaning, the glyph carries the tone. */}
        <WarningIcon />
        <h2
          id="fab-sim-stopped-heading"
          className="fab-title"
          style={{
            margin: 0,
            fontSize: 'var(--fab-font-size-hero)',
            lineHeight: 1.2,
            color: 'var(--fab-ink)',
          }}
        >
          {SIM_STOPPED_COPY.heading}
        </h2>
      </div>

      {shown !== '' && (
        <p
          // The host's sentence as one React text child, never markup (T-90-21). A panic
          // payload can hold an unbroken token (a path) wider than the card, so it may wrap
          // anywhere (UI-SPEC A4).
          id="fab-sim-stopped-reason"
          data-fab-sim-stopped-reason=""
          style={{ ...paragraph, overflowWrap: 'anywhere' }}
        >
          {shown}
        </p>
      )}

      <p id="fab-sim-stopped-consequence" style={paragraph}>
        {SIM_STOPPED_COPY.consequence}
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {/* Its own live region only while it holds a result, so the return to the idle word is
            not announced; `aria-disabled` and `aria-busy` while the write is pending, never the
            real `disabled` (disabling a focused button drops focus). The `WebhookUrlRow` rules. */}
        <button
          ref={buttonRef}
          type="button"
          className="fab-dialog-btn"
          data-fab-sim-stopped-copy=""
          // Review IN-B-01: focus lands here on mount, and the label names only the action, so the
          // button points at what it is about: a screen reader that reads only the focused control
          // still hears that the simulation stopped and why.
          aria-describedby={
            shown !== ''
              ? 'fab-sim-stopped-heading fab-sim-stopped-reason fab-sim-stopped-consequence'
              : 'fab-sim-stopped-heading fab-sim-stopped-consequence'
          }
          aria-disabled={inFlight ? true : undefined}
          aria-busy={inFlight ? true : undefined}
          aria-live={hasResult ? 'polite' : 'off'}
          style={{ minWidth: SIM_STOPPED_COPY_MIN_WIDTH, whiteSpace: 'nowrap' }}
          onClick={onCopy}
        >
          {SIM_STOPPED_COPY_LABELS[copyState]}
        </button>
      </div>
    </div>
  );
}
