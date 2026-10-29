// FactoryConfigBody.tsx - the HUD-themed CodeMirror 6 Factory JS editor (CFG-01).
//
// The 39-08 upgrade of the 39-07 `.fab-field` <textarea> fallback: a real
// CodeMirror 6 editor that reads as part of the game HUD, not a foreign IDE.
// Every theme + syntax colour is a `var(--fab-*)` token (UI-SPEC "CodeMirror 6
// Editor Theme" table) - ZERO hand-authored hex.
//
// The editor is UNCONTROLLED (RESEARCH Q1 / Pitfall 3): the EditorView is
// constructed ONCE in `useEffect([])`, held in a ref, and `view.destroy()`d on
// unmount - never recreated on a React re-render (that is the controlled-CM
// cursor-jump pitfall). React state is NOT bound per keystroke; the parent
// (ConfigPanel) reads the exact doc bytes on Apply and pushes external pre-fill /
// Revert values through a SINGLE guarded `dispatch`. Dirty is signalled via an
// `updateListener` (the parent's not-applied marker) and SUPPRESSED during a
// programmatic pre-fill/Revert so restoring the committed source is not itself a
// dirtying edit.
//
// The @codemirror/* modules are composed individually (state/view/commands/
// language/lang-javascript) - NEVER the `codemirror` meta-package, whose
// basicSetup ships a default theme that fights the token theme (UI-SPEC). The
// extension set is deliberately restricted (no autocomplete/lint).
//
// The non-React core lives in `FactoryEditorController` + the pure `fabTheme` /
// `fabHighlight` / `factoryEditorExtensions` so the buffer semantics (exact-bytes
// read, guarded idempotent pre-fill, suppressed-dirty) are unit-testable in the
// repo's `node` vitest env WITHOUT a DOM - only the thin `useEffect` mount that
// news an `EditorView` needs one, and that is exercised live in the 39-08 e2e
// gate (the v5.0 live-oracle lesson).

import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef, type CSSProperties, type JSX, type RefObject } from 'react';

// ── The HUD theme - every value a `var(--fab-*)` token (UI-SPEC table). ──────
// `&` targets the editor wrapper; the inner surfaces map 1:1 to the spec. The
// editor rides the chrome font tokens (Martian Mono base, Phase 47) so it
// matches the surrounding chrome, not a system mono.
export const fabTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--fab-substrate)',
      color: 'var(--fab-ink)',
      border: '1px solid var(--fab-edge-lit)',
      borderRadius: '0',
      fontFamily: 'var(--fab-font)',
      fontSize: 'var(--fab-font-size-base)',
      height: '100%',
    },
    '&.cm-focused': {
      outline: '2px solid var(--fab-focus)',
      outlineOffset: '1px',
    },
    '.cm-scroller': {
      fontFamily: 'var(--fab-font)',
      lineHeight: '1.4',
      overflow: 'auto',
    },
    '.cm-content': {
      color: 'var(--fab-ink)',
      caretColor: 'var(--fab-focus)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--fab-focus)',
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: 'var(--fab-focus)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--fab-panel-fill)',
      color: 'var(--fab-edge-lit)',
      border: 'none',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: 'var(--fab-edge-lit)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--fab-panel-fill)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--fab-panel-fill)',
      color: 'var(--fab-ink)',
    },
    // drawSelection paints `.cm-selectionBackground`; native selection falls back
    // to `::selection`. Both read the neutral edge token on the substrate.
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--fab-edge-lit)',
    },
  },
  { dark: true },
);

// ── The syntax palette - max 5 hues, all reusing the exact canvas accents so the
//    editor reads as part of the game world, never a rainbow IDE (UI-SPEC). ────
export const fabHighlight = HighlightStyle.define([
  // keyword / operator / control → the one build-blue accent.
  { tag: [t.keyword, t.operator, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: 'var(--fab-focus)' },
  // string / regexp → the working-green canvas accent.
  { tag: [t.string, t.regexp, t.special(t.string)], color: 'var(--fab-accent-working)' },
  // number / boolean / constant → the item-amber canvas accent.
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--fab-accent-item)' },
  // comment → muted edge tone (no italic - the pixel font has no true italic).
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--fab-edge-lit)' },
  // variableName / default identifiers → body ink.
  { tag: [t.variableName, t.propertyName, t.name], color: 'var(--fab-ink)' },
  // invalid → the destructive token (the one place red belongs).
  { tag: t.invalid, color: 'var(--fab-destructive)' },
]);

/** The minimal, restricted extension set (RESEARCH Q1) - NO autocomplete/lint.
 *  The `updateListener` routes every doc-changing view update to the controller,
 *  which decides whether it is a user edit (dirty) or a suppressed programmatic
 *  pre-fill. Exported so a node test can prove the set composes into a valid
 *  `EditorState` without a DOM. */
export function factoryEditorExtensions(controller: FactoryEditorController): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    history(),
    javascript(),
    syntaxHighlighting(fabHighlight),
    fabTheme,
    EditorView.lineWrapping,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((u) => controller.onUpdate(u.docChanged)),
  ];
}

/** The minimal view surface the controller drives - the real `EditorView`
 *  satisfies it, and a node test injects a fake around a real `EditorState`
 *  (no DOM) to exercise the buffer semantics. */
export interface EditorViewLike {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  destroy(): void;
}

/** The imperative handle the parent (ConfigPanel) holds: read the EXACT current
 *  bytes on Apply, push a committed/pre-fill value on Revert/load. */
export interface FactoryEditorHandle {
  /** The exact current doc bytes (no reformat). */
  read(): string;
  /** Push an external value via a single guarded dispatch; returns whether it
   *  actually dispatched (false when the value already matches). */
  setSource(next: string): boolean;
}

/**
 * The non-React editor core. Owns the (single) view, exposes exact-bytes read +
 * guarded idempotent pre-fill, and gates the dirty signal so a programmatic
 * pre-fill/Revert never marks the buffer dirty. DOM-free and fully unit-testable
 * (the React shell only supplies a real `EditorView`).
 */
export class FactoryEditorController {
  private view: EditorViewLike | null = null;
  /** True only DURING a programmatic dispatch, so the updateListener knows the
   *  resulting doc change is a pre-fill/Revert, not a user keystroke. */
  private suppressDirty = false;

  constructor(private readonly onDirty: () => void) {}

  /** True once a view is attached (construct-once: a second attach is ignored). */
  get mounted(): boolean {
    return this.view !== null;
  }

  /** Attach the constructed view ONCE - idempotent, so a re-render that somehow
   *  re-invokes this never swaps the live view (the uncontrolled-mount contract). */
  attach(view: EditorViewLike): void {
    if (this.view) return;
    this.view = view;
  }

  /** Destroy the view on unmount and drop the reference. */
  destroy(): void {
    this.view?.destroy();
    this.view = null;
  }

  /** The EXACT current buffer bytes - what Apply commits (no reformat/prettify). */
  read(): string {
    return this.view ? this.view.state.doc.toString() : '';
  }

  /** Push an external value through a SINGLE guarded dispatch. Idempotent: when
   *  the incoming value already matches the doc it does NOT dispatch (no clobber
   *  of an in-progress edit, no cursor jump). The dispatch is flagged so the
   *  resulting doc change does not mark the buffer dirty. */
  setSource(next: string): boolean {
    const view = this.view;
    if (!view) return false;
    if (view.state.doc.toString() === next) return false;
    this.suppressDirty = true;
    try {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    } finally {
      this.suppressDirty = false;
    }
    return true;
  }

  /** The updateListener target: a doc change that is NOT a suppressed programmatic
   *  push is a user edit → signal dirty. */
  onUpdate(docChanged: boolean): void {
    if (docChanged && !this.suppressDirty) this.onDirty();
  }
}

const HOST_STYLE: CSSProperties = {
  // The host has a DEFINITE clamp height the editor fills (fabTheme `&` height
  // 100%) and scrolls inside (`.cm-scroller` overflow auto); the colours/border
  // come from `fabTheme &`, so no hex here. A definite height - never indefinite
  // bounds or flex stretch - is what resolves identically on Blink and WebKitGTK.
  height: 'clamp(180px, 40vh, 480px)',
  overflow: 'hidden',
  display: 'flex',
};

const LABEL_STYLE: CSSProperties = {
  fontFamily: 'var(--fab-font)',
  fontSize: 'var(--fab-font-size-base)',
  color: 'var(--fab-ink)',
  lineHeight: 1,
};

/**
 * The editor labels, keyed by what the box actually holds (72-10 / R-69).
 *
 * # THIS IS A RESEARCHER CALL CARRIED TO THE WALK, NOT A SETTLED DECISION
 * 72-UI-SPEC 4.2 makes it and names it in plan 72-14's judgement list on the UI
 * checker's own recommendation, because it changes one of the most-read labels in
 * the app. A blank verdict at the walk therefore reads as a blank rather than as a
 * pass, and ONE WORD reverts it: put `Handler (JS)` back on the FACTORY row.
 *
 * # THE REASON IT IS TWO LABELS AND NOT ONE
 * After phase 72, `Handler` is the name of a MACHINE in the palette. This box's
 * label was `Handler (JS)` on every kind, meaning "the handler function you write".
 * One word naming two things in one app is exactly the drift D-10 exists to close,
 * and closing it in the kind-name table while opening it here would have been
 * pointless.
 *
 * `Handler (JS)` stays on a HANDLER - it is the established word for that box, from walk
 * step 2, and it is unchanged there. `Transform (JS)` goes on a plain FACTORY,
 * taking its noun from the Palette's own shipped Factory line, `Transforms items
 * (runs your code)`, rather than from a word invented here.
 *
 * The ALTERNATIVE, stated so it can be chosen instead: leave both boxes reading
 * `Handler (JS)` and accept the collision. Cheaper by one pinned string, worse by
 * one ambiguous noun on the busiest label in the product.
 */
export const FACTORY_EDITOR_LABELS = {
  factory: 'Transform (JS)',
  handler: 'Handler (JS)',
} as const;

export type FactoryEditorLabel =
  (typeof FACTORY_EDITOR_LABELS)[keyof typeof FACTORY_EDITOR_LABELS];

export interface FactoryConfigBodyProps {
  /** The committed source to seed the editor with, read ONCE at mount. */
  initialSource: string;
  /** The parent's imperative handle slot - populated on mount, cleared on unmount. */
  handleRef: RefObject<FactoryEditorHandle | null>;
  /** Fired on a USER edit (not a programmatic pre-fill) → the parent's dirty flag. */
  onDirty: () => void;
  /** The editor's label, chosen by the SELECTED KIND (R-69). REQUIRED rather than
   *  defaulted: a default would silently put one machine's word on the other's box,
   *  which is the collision this prop exists to end. See
   *  {@link FACTORY_EDITOR_LABELS}. */
  label: FactoryEditorLabel;
}

/**
 * The React shell: mounts the CodeMirror `EditorView` exactly once, wires the
 * controller + the parent handle, and tears down on unmount. `initialSource` /
 * `onDirty` are captured through refs so the [] effect never needs to re-run
 * (which would recreate the view and jump the cursor).
 */
export function FactoryConfigBody({ initialSource, handleRef, onDirty, label }: FactoryConfigBodyProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  // Latest-callback / seed refs so the construct-once effect reads current values
  // without listing them as deps (deps must stay [] - see the module header).
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const seedRef = useRef(initialSource);

  useEffect(() => {
    const controller = new FactoryEditorController(() => onDirtyRef.current());
    const view = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        doc: seedRef.current,
        extensions: factoryEditorExtensions(controller),
      }),
    });
    controller.attach(view);
    handleRef.current = {
      read: () => controller.read(),
      setSource: (next) => controller.setSource(next),
    };
    return () => {
      controller.destroy();
      handleRef.current = null;
    };
    // Construct ONCE - never recreate on re-render (the uncontrolled-buffer rule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fab-space-sm)' }}>
      <label htmlFor="fab-factory-src" style={LABEL_STYLE}>
        {label}
      </label>
      <div id="fab-factory-src" ref={host} className="fab-cm-host" style={HOST_STYLE} />
    </div>
  );
}
