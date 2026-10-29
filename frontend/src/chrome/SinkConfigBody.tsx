// SinkConfigBody.tsx — the Sink authoring body (CFG-01).
//
// A `Target` segmented control (Debug / HTTP) as `.fab-tool-btn is-pressed`
// segments (NOT a native <select>) — exactly one pressed (the single-select
// invariant). Phase 85 (CHROME-04) removed the Email segment and its `To` /
// `Subject` fields with the Email target itself. HTTP reveals a `URL`
// `.fab-field` plus a `Method` GET/POST/PUT/PATCH/DELETE segmented control mapping
// to the HttpMethod byte (Get=0..Delete=4, the frozen wire order). Purely
// presentational: told the current target via props, raising the new SinkTemplate
// via onChange.
//
// Skin, not skeleton: every colour a `--fab-*` token, all text on the Martian
// Mono body tokens, 44px min-target on every control. No hand-authored
// hex; the method byte mirrors the frozen Rust HttpMethod exactly.

import type { CSSProperties, JSX } from 'react';
import type { SinkTemplate } from '../protocol/decode.ts';

/** HTTP method labels indexed by the frozen HttpMethod byte (Get=0..Delete=4). */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * The verb a newly-switched HTTP sink starts on: POST, matching the core's own
 * `#[default]` on `HttpMethod` (`crates/fabrico-core/src/state.rs`).
 *
 * **THIS USED TO BE A BARE `0`, WHICH IS GET.** It was invisible while the host
 * hard-coded POST for every dispatch; the moment the verb was threaded through
 * (`crates/fabrico-host/src/sinks/http.rs`), every HTTP sink a user configured
 * without pressing the Method segment would have started sending GET. Named
 * rather than re-typed as a literal so the two defaults cannot drift apart
 * again.
 */
export const HTTP_METHOD_DEFAULT = HTTP_METHODS.indexOf('POST');

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/** One `.fab-tool-btn is-pressed` segment. A render HELPER invoked directly (not
 *  `<Segment/>`) so the <button> inlines into the body tree for node-env test
 *  walking (the DeleteControl direct-invocation discipline; no hooks here). */
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

/** A stacked labelled `.fab-field` text row (render helper, invoked directly). */
function field(
  id: string,
  label: string,
  value: string,
  onChange: (value: string) => void,
  numeric?: boolean,
): JSX.Element {
  return (
    <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label htmlFor={id} style={LABEL_STYLE}>
        {label}
      </label>
      <input
        id={id}
        className="fab-field"
        type="text"
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        style={numeric ? { fontVariantNumeric: 'tabular-nums' } : undefined}
      />
    </div>
  );
}

export interface SinkConfigBodyProps {
  target: SinkTemplate;
  onChange: (target: SinkTemplate) => void;
}

export function SinkConfigBody({ target, onChange }: SinkConfigBodyProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-md)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
        <label style={LABEL_STYLE}>Target</label>
        <div role="group" aria-label="Target" style={{ display: 'flex', gap: 'var(--fab-space-xs)' }}>
          {segment('Debug', target.kind === 'Debug', () => onChange({ kind: 'Debug' }))}
          {segment('HTTP', target.kind === 'Http', () =>
            onChange(
              target.kind === 'Http' ? target : { kind: 'Http', url: '', method: HTTP_METHOD_DEFAULT },
            ),
          )}
        </div>
      </div>

      {target.kind === 'Http' && (
        <>
          {field(
            'fab-sink-http-url',
            'URL',
            target.url,
            (url) => onChange({ kind: 'Http', url, method: target.method }),
            true,
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
            <label style={LABEL_STYLE}>Method</label>
            <div
              role="group"
              aria-label="Method"
              style={{ display: 'flex', gap: 'var(--fab-space-xs)', flexWrap: 'wrap' }}
            >
              {HTTP_METHODS.map((label, byte) =>
                segment(label, target.method === byte, () =>
                  onChange({ kind: 'Http', url: target.url, method: byte }),
                ),
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
