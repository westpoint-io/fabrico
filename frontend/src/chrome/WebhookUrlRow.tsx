// WebhookUrlRow.tsx - the copyable webhook URL row for a Source (CFG-03).
//
// A read-only monospace URL value (fetched over the injected `webhook_url` host
// bridge) plus a `Copy` button that reports what the write actually did, holding
// its result for ~1.5s (the StatusReadout transient-readout precedent). When no
// bound URL is available it shows a disabled "Webhook not ready" placeholder and a
// disabled Copy button (the url-unavailable state). The value keeps its FULL string
// regardless of visible truncation (overflow is presentational only), so a copy
// always yields the whole URL.
//
// QA-01: the button used to say "Copied" unconditionally, on top of a discarded
// `navigator.clipboard?.writeText(url)` that no-ops entirely under WebKitGTK. It is
// now driven by a `copyState` that reaches `'copied'` ONLY on the resolved branch of
// an awaited write (`runCopy`), and `'failed'` from an observed rejection, a
// synchronous throw, or a provably absent API. Never from elapsed time: the result
// hold timer below returns a settled result to rest and never decides one.
//
// Split into a pure `WebhookUrlRowView` (told url/copyState via props - node-env
// testable by direct invocation, the DeleteControl discipline) and the `WebhookUrlRow`
// hook wrapper that owns the fetch, the injectable `copy` writer and one
// `makeCopyMachine` instance. The guards themselves (re-entrancy early return,
// click epoch, result-hold timer) live in that machine rather than in this file,
// because this repo's vitest environment is `node`: a guard reachable only
// through a rendered React tree could be covered by nothing but a browser suite,
// and a browser suite is structurally blind to this exact bug class.
// Skin, not skeleton: every colour a `--fab-*` token, all text on the Martian Mono
// body tokens, the value reads as a `.fab-field` inset well, the button is a
// `.fab-tool-btn`.

import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import type { ConfigInvoke } from './ConfigPanel.tsx';
import {
  clipboardCopy,
  makeCopyMachine,
  type CopyMachine,
  type CopyState,
} from './clipboardCopy.ts';

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** The button's ENTIRE vocabulary (52-UI-SPEC, Copywriting Contract). There is no
 *  fourth word, no toast, no banner, no alert row and no status-bar message. The
 *  in-flight state deliberately holds the idle label: nothing has happened yet. */
export const COPY_LABELS: Record<CopyState, string> = {
  idle: 'Copy',
  copying: 'Copy',
  copied: 'Copied',
  failed: 'Copy failed',
};

/** The button's reserved width, in `ch`, DERIVED from the label set (52-UI-SPEC
 *  A8) and never written as a number. In Martian Mono one `ch` is exactly one
 *  advance, so the widest word fits and the label swap cannot reflow the row or
 *  make the URL slot beside it jump. Deriving it is the whole point: a future
 *  copy change moves the reservation with it instead of silently reintroducing
 *  the layout shift the maintainer ruled out. */
export const COPY_LABEL_MAX_CH = Math.max(...Object.values(COPY_LABELS).map((l) => l.length));

export interface WebhookUrlRowViewProps {
  /** The resolved URL, or null when no bound port is available yet. */
  url: string | null;
  /** Which of the four named copy states the button is showing. */
  copyState: CopyState;
  onCopy: () => void;
  /** The row label. Defaults to "Webhook URL" (the Source call site); the
   *  Endpoint card passes "POST URL". Renders as a React text child (no innerHTML). */
  label?: string;
}

export function WebhookUrlRowView({ url, copyState, onCopy, label = 'Webhook URL' }: WebhookUrlRowViewProps): JSX.Element {
  const available = url !== null && url !== '';
  const inFlight = copyState === 'copying';
  // A settled result is the only thing worth speaking (see the note below).
  const hasResult = copyState === 'copied' || copyState === 'failed';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label style={LABEL_STYLE}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fab-space-sm)' }}>
        {available ? (
          <span
            className="fab-field"
            title={url ?? undefined}
            style={{
              flex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {url}
          </span>
        ) : (
          <span
            className="fab-field"
            aria-disabled="true"
            style={{
              flex: 1,
              display: 'inline-flex',
              alignItems: 'center',
              filter: 'saturate(0) brightness(0.8)',
            }}
          >
            Webhook not ready
          </span>
        )}
        {/*
          * The copy result is carried ENTIRELY by the word. The class, the tint,
          * the size and the geometry are identical in all five states.
          *
          * POLITE, NOT ALERT (the house rule: ConfigPanel.tsx:125 errorRow is the
          * interrupting tier, PortsSection.tsx:341-357 is the polite one). A
          * failed clipboard write destroys nothing, diverges no state and loses
          * no data, and the recovery is one click on the control already under
          * the pointer - so it takes no alert role and no destructive tint, and
          * joins the tier PortsSection already put PORT_EDIT_PENDING and
          * PORT_EDIT_STALLED in. The button is its OWN live region because its
          * accessible name IS the state (A3): there is no screen-reader-only
          * utility class in this repo to build a hidden sibling with, and a
          * sibling would only duplicate the announcement.
          *
          * WHAT IS ANNOUNCED IS THE RESULT, NOT THE RESET. The button being its
          * own live region means EVERY content change inside it is announced,
          * including the hold timer swapping `Copied` back to `Copy` 1.5s later.
          * A screen-reader user heard "Copied", then - unprompted, with focus
          * still on the button and no user action in between - "Copy". That
          * second announcement carries no information and is exactly the noise
          * the polite tier exists to avoid ("Copy failed" then "Copy" on the
          * failure path). So the region is live only while there is a RESULT to
          * announce; the return to idle is a visual reset, not news.
          *
          * It is `aria-live="off"`, NOT a dropped attribute: the region must
          * stay established on the element across the content change, and
          * removing the attribute entirely would tear it down and re-create it.
          * The element is a live region in all four states, as A3 requires - the
          * politeness is what varies.
          *
          * The real `disabled` attribute is bound to the availability guard and
          * to NOTHING else. The in-flight guard is `aria-disabled` plus the early
          * return in `onCopy`, because disabling a FOCUSED button drops focus to
          * `<body>` in Chromium and WebKit, which would silence this very
          * announcement for the keyboard user who pressed Enter to trigger it.
          */}
        <button
          type="button"
          className="fab-tool-btn"
          disabled={!available}
          aria-disabled={inFlight ? true : undefined}
          aria-busy={inFlight ? true : undefined}
          aria-live={hasResult ? 'polite' : 'off'}
          style={{ minWidth: `${COPY_LABEL_MAX_CH}ch`, whiteSpace: 'nowrap' }}
          onClick={onCopy}
        >
          {COPY_LABELS[copyState]}
        </button>
      </div>
    </div>
  );
}

export interface WebhookUrlRowProps {
  node: number;
  invoke: ConfigInvoke;
  /** The row label, threaded to the view. Defaults to "Webhook URL". */
  label?: string;
  /** The clipboard writer, injectable exactly like `ConfigInvoke` so both the
   *  success and the failure branch are node-testable without a browser. The
   *  default is the real env-branched writer, so both existing call sites
   *  (SourceConfigBody "Webhook URL", ConfigPanel "POST URL") stay untouched. */
  copy?: (text: string) => Promise<void>;
  /**
   * A value that changes when the ANSWER to `webhook_url` could have changed for the
   * SAME node, added at 72-13 and OPTIONAL so the Source call site stays untouched.
   *
   * WHY IT EXISTS, MEASURED ON THE REAL HOST AND NOT REASONED. The fetch below was
   * keyed `[node, invoke]` only, which is correct for a Source: its `/hook/src-<id>`
   * URL is derived from the node id and nothing a user can type moves it. It is WRONG
   * for a Route from SERVE-05 onward: the URL is `/endpoint<path>` and the path is now
   * an editable field, so typing `/orders` and pressing Apply left this row showing the
   * OLD default `/endpoint/<path>` string until the panel was closed and reopened.
   *
   * That is the worst possible thing for this particular row to get wrong, because the
   * row has a COPY BUTTON on it: the user copies a URL the listener no longer serves,
   * gets a 404, and has no way to tell that the panel was stale rather than their route
   * broken. `72-UI-SPEC` section 5 walk step 4 states the required behaviour plainly -
   * "Type `/orders`, press Apply. The URL row becomes ...".
   *
   * The row still SHOWS ONLY THE COMMITTED PATH and never the typed one, which is the
   * property the ConfigPanel call site's comment is about: this key is the COMMITTED
   * config, so a re-fetch happens after the fold and not on a keystroke, and the string
   * on screen is still whatever the HOST answers.
   */
  refreshKey?: string;
}

/** The hook wrapper: fetches the URL over `webhook_url` on mount and owns the
 *  copy result transient. A failed/absent query leaves url=null → the
 *  "Webhook not ready" disabled placeholder (the url-unavailable backstop). */
export function WebhookUrlRow({
  node,
  invoke,
  label,
  copy = clipboardCopy,
  refreshKey,
}: WebhookUrlRowProps): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  // The injected writer, read through a ref so the machine below is built ONCE
  // (keeping its guards) while still calling the current prop.
  const copyRef = useRef(copy);
  useEffect(() => {
    copyRef.current = copy;
  }, [copy]);
  // The re-entrancy guard, the click epoch and the result-hold timer all live in
  // `makeCopyMachine` (the statusMachine.ts house pattern), which is what keeps
  // the ConfigPanel appliedTimer discipline - one timer, cleared on unmount,
  // restarted on a re-click - provable in the node test env instead of only in a
  // browser. THE HUNG-IPC END STATE IS DECIDED AND RECORDED THERE, beside the
  // guard: a never-settling write holds state 3 for the lifetime of THIS mounted
  // row, and the escape (deselect and reselect, which unmounts this row) is an
  // ESCAPE, NOT A DIAGNOSIS - while hung the button is visually identical to
  // idle, so the user can get out but cannot tell anything went wrong.
  const machineRef = useRef<CopyMachine | null>(null);

  useEffect(() => {
    let alive = true;
    invoke('webhook_url', { node })
      .then((u) => {
        if (alive) setUrl((u as string | null) ?? null);
      })
      .catch(() => {
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
    };
    // `refreshKey` is in the dep list and deliberately unread in the body: it is a
    // CHANGE SIGNAL, not an input. The URL is answered by the HOST from folded state,
    // so re-deriving it here from the key would be a second URL producer and exactly
    // the drift this row's own docblock exists to prevent.
  }, [node, invoke, refreshKey]);

  // The single unmount cleanup: disposing the machine cancels its hold timer and
  // makes any in-flight settlement inert (the click epoch), so nothing lands on a
  // row that is gone. Nulling the ref lets a StrictMode remount build a fresh
  // machine on the next click rather than reusing a disposed one.
  useEffect(
    () => () => {
      machineRef.current?.dispose();
      machineRef.current = null;
    },
    [],
  );

  const onCopy = (): void => {
    if (url == null || url === '') return;
    if (machineRef.current === null) {
      machineRef.current = makeCopyMachine({
        copy: (text) => copyRef.current(text),
        setState: setCopyState,
      });
    }
    machineRef.current.click(url);
  };

  return <WebhookUrlRowView url={url} copyState={copyState} onCopy={onCopy} label={label} />;
}
