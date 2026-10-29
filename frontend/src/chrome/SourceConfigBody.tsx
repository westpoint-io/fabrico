// SourceConfigBody.tsx — the Source authoring body (CFG-01/CFG-03).
//
// A `Trigger` segmented control (Webhook / Timer) as `.fab-tool-btn is-pressed`
// segments (NOT a native <select>, so the whole selector stays on the shipped
// bevel language) — exactly one segment pressed at a time (the zero-one-many
// single-select invariant). Choosing Timer reveals a numeric `Every … ticks`
// `.fab-field`. It hosts the copyable `<WebhookUrlRow>` while the APPLIED trigger is
// Webhook (DEMO-08). Purely presentational: told the current trigger via props,
// raising the new SourceTrigger via onChange.
//
// Skin, not skeleton: every colour a `--fab-*` token, all text on the Martian
// Mono body tokens, 44px min-target on every control (the .fab-field /
// .fab-tool-btn classes carry it). No hand-authored hex.

import type { CSSProperties, JSX } from 'react';
import type { SourceTrigger } from '../protocol/decode.ts';
import type { ConfigInvoke } from './ConfigPanel.tsx';
import { WebhookUrlRow } from './WebhookUrlRow.tsx';

/** The default interval a fresh Timer trigger starts on (ticks). ~1s at 60 t/s. */
export const DEFAULT_TIMER_INTERVAL = 60;

/**
 * The largest interval the field commits: 2^53 - 1, the largest integer a JS number holds
 * exactly (phase 91 review CR-B-01, T-91-24, UF-91-02). Past it the field could not show the
 * figure it sends (from 1e21 `String` prints `1e+21`), and `PostcardWriter.varintU` refuses it.
 * The host takes a `u64`, so every value up to this one reaches it unchanged. At 60 ticks a
 * second it is about 4.7 million years.
 */
export const MAX_TIMER_INTERVAL = Number.MAX_SAFE_INTEGER;

/**
 * Coerce the timer field's raw text to a committable interval: an integer from 1 to
 * {@link MAX_TIMER_INTERVAL} (F3). The field is `type="text"` with a numeric keyboard (phase 91,
 * CHROME-14, D-08), so a user can type `-5`, `1.9`, `abc`, clear the field, or paste `Infinity`,
 * `1e400` or thirty nines. Left unsanitized, `PostcardWriter.varintU` refuses or mangles those
 * (it used to loop forever on `Infinity`, which hung Apply), so the LOGGED config would diverge
 * from what the panel displays. Empty, NaN, zero and negatives give 1; anything at or past the
 * cap (`Infinity` included) gives the cap; a fraction floors. The result is exactly the value that
 * gets encoded, so committed == displayed once the field shows it (on blur, `ConfigPanel`).
 */
export function sanitizeTimerInterval(raw: string): number {
  const n = Number(raw);
  if (Number.isNaN(n) || n < 1) return 1;
  if (n >= MAX_TIMER_INTERVAL) return MAX_TIMER_INTERVAL;
  return Math.floor(n);
}

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** One `.fab-tool-btn is-pressed` segment (the shipped pressed-toggle bevel). A
 *  render HELPER invoked directly (not `<Segment/>`) so the <button> inlines into
 *  the body tree and the node-env tests can walk it (the DeleteControl
 *  direct-invocation discipline; no hooks here). */
function segment(label: string, pressed: boolean, onClick: () => void): JSX.Element {
  return (
    <button
      key={label}
      type="button"
      className={pressed ? 'fab-tool-btn is-pressed' : 'fab-tool-btn'}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export interface SourceConfigBodyProps {
  trigger: SourceTrigger;
  onChange: (trigger: SourceTrigger) => void;
  node: number;
  invoke: ConfigInvoke;
  /**
   * The trigger kind the HOST has folded for this Source (the panel's committed config),
   * or `undefined` before it is known. The URL row renders only when it is `Webhook`
   * (DEMO-08, D-20): a Source on Timer has no webhook door, so its URL would answer 404.
   */
  committedTrigger?: SourceTrigger['kind'];
  /**
   * The Every field's RAW typed text, or null while the field shows the buffer (phase 91 review
   * WR-B-01, the belt pace field's `beltTyped` pattern). `ConfigPanel` holds it, because this body
   * holds no hooks. Without it the field showed the sanitized number after every keystroke, so
   * `12.` snapped back to `12` and the next `7` read `127`. Optional: a caller without it gets the
   * buffer's figure, as before.
   */
  typed?: string | null;
  /** Told the raw text on every keystroke, and null when the field is left or a segment is
   *  pressed, so the field then shows the sanitized figure Apply commits. */
  onTyped?: (typed: string | null) => void;
}

export function SourceConfigBody({
  trigger,
  onChange,
  node,
  invoke,
  committedTrigger,
  typed = null,
  onTyped,
}: SourceConfigBodyProps): JSX.Element {
  const isTimer = trigger.kind === 'Timer';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-md)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
        <label style={LABEL_STYLE}>Trigger</label>
        <div role="group" aria-label="Trigger" style={{ display: 'flex', gap: 'var(--fab-space-xs)' }}>
          {segment('Webhook', trigger.kind === 'Webhook', () => {
            onTyped?.(null);
            onChange({ kind: 'Webhook' });
          })}
          {segment('Timer', isTimer, () => {
            onTyped?.(null);
            onChange({
              kind: 'Timer',
              interval_ticks: isTimer ? trigger.interval_ticks : DEFAULT_TIMER_INTERVAL,
            });
          })}
        </div>
      </div>

      {isTimer && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
          <label htmlFor="fab-timer-interval" style={LABEL_STYLE}>
            Every
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-xs)' }}>
            {/* TEXT WITH A NUMERIC KEYBOARD, NO RANGE (phase 91, CHROME-14, D-08, the belt
                pace field's precedent in `BeltConfigBody.tsx`). A number input draws the
                OS's light spin buttons, a white control on the dark panel on WebKitGTK, and
                its `min` enforced nothing; `sanitizeTimerInterval` on every change is the
                guard, so only an integer from 1 to the cap reaches the Configure. THE FIELD
                SHOWS WHAT WAS TYPED (review WR-B-01): the raw text is held by the parent while
                the field has it, the buffer takes the sanitized figure, and leaving the field
                swaps the text for that figure, so the field reads what Apply commits before
                Apply is pressed (a press on Apply leaves the field first). */}
            <input
              id="fab-timer-interval"
              className="fab-field"
              type="text"
              inputMode="numeric"
              value={typed ?? String(trigger.interval_ticks)}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                onTyped?.(raw);
                onChange({
                  kind: 'Timer',
                  interval_ticks: sanitizeTimerInterval(raw),
                });
              }}
              onBlur={() => onTyped?.(null)}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
            <span style={LABEL_STYLE}>ticks</span>
          </div>
        </div>
      )}

      {/* DEMO-08 (plan 85-01, D-20, 72-UI-SPEC 3.1): the row shows what the HOST has
          folded, never the typed buffer, for the reason the Route's POST URL row gives.
          A Source on Timer has no door (the host leaves it out of the route table), so a
          URL here would be a 404 handed over with a Copy button; and a Webhook typed but
          not yet applied is not a door yet either. Keyed on the committed kind so an Apply
          that opens the door fetches the URL afresh. The interval field above still
          follows the buffer, because that is the value being edited. */}
      {committedTrigger === 'Webhook' && (
        <WebhookUrlRow node={node} invoke={invoke} refreshKey={committedTrigger} />
      )}
    </div>
  );
}
