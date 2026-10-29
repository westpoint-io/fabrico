import { describe, expect, it, vi } from 'vitest';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import {
  FactoryEditorController,
  factoryEditorExtensions,
  fabTheme,
  fabHighlight,
  type EditorViewLike,
} from './FactoryConfigBody.tsx';

// The vitest env is `node` (no DOM — the repo's zero-new-packages discipline).
// A real CodeMirror `EditorView` needs a DOM, but `EditorState` and the whole
// buffer contract (exact-bytes read, guarded idempotent pre-fill, suppressed
// dirty on programmatic push, construct-once attach) are DOM-FREE: we drive the
// `FactoryEditorController` around a fake `EditorViewLike` backed by a REAL
// `EditorState` built from the REAL extension set. The live mount + keystroke +
// Apply is proven in the 12-config-apply e2e:live gate (the v5.0 live-oracle
// lesson) — vitest here is necessary, not sufficient.

/**
 * A DOM-free `EditorViewLike` backed by a real `EditorState`: `dispatch` applies
 * the transaction (so read-after-push reflects it) and records every spec, so a
 * test can assert BOTH the resulting doc and the exact change spec.
 */
function fakeView(doc: string, extensions = factoryEditorExtensions(new FactoryEditorController(() => {}))) {
  let state = EditorState.create({ doc, extensions });
  const dispatched: TransactionSpec[] = [];
  let destroyed = false;
  const view: EditorViewLike = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      dispatched.push(spec);
      state = state.update(spec).state;
    },
    destroy() {
      destroyed = true;
    },
  };
  return { view, dispatched, isDestroyed: () => destroyed };
}

describe('factoryEditorExtensions — the restricted set composes (no DOM)', () => {
  it('builds a valid EditorState from the real extension set (JS + highlight + theme + listener)', () => {
    const controller = new FactoryEditorController(() => {});
    const state = EditorState.create({
      doc: 'export default (x) => x;',
      extensions: factoryEditorExtensions(controller),
    });
    expect(state.doc.toString()).toBe('export default (x) => x;');
  });

  it('exports the token-mapped theme + highlight (no meta-package default theme)', () => {
    expect(fabTheme).toBeDefined();
    expect(fabHighlight).toBeDefined();
  });
});

describe('FactoryEditorController — mounts_once (construct-once + destroy)', () => {
  it('attaches the view ONCE — a second attach is ignored (no live-view swap)', () => {
    const controller = new FactoryEditorController(() => {});
    const first = fakeView('const a = 1;');
    const second = fakeView('const b = 2;');
    expect(controller.mounted).toBe(false);
    controller.attach(first.view);
    expect(controller.mounted).toBe(true);
    controller.attach(second.view); // idempotent — must NOT replace the first view
    expect(controller.read()).toBe('const a = 1;');
  });

  it('destroy() tears the view down and clears the reference', () => {
    const controller = new FactoryEditorController(() => {});
    const { view, isDestroyed } = fakeView('const a = 1;');
    controller.attach(view);
    controller.destroy();
    expect(isDestroyed()).toBe(true);
    expect(controller.mounted).toBe(false);
    expect(controller.read()).toBe(''); // no view → empty, never throws
  });
});

describe('FactoryEditorController — commit_exact_bytes', () => {
  it('read() returns the EXACT current doc bytes (no reformat/prettify)', () => {
    const messy = "  const   x=1 ;\n\n\tif(x){return   'y'}  ;";
    const controller = new FactoryEditorController(() => {});
    controller.attach(fakeView(messy).view);
    expect(controller.read()).toBe(messy);
  });
});

describe('FactoryEditorController — dirty_marker (updateListener wiring)', () => {
  it('a user doc change signals dirty; a non-doc update does NOT', () => {
    const onDirty = vi.fn();
    const controller = new FactoryEditorController(onDirty);
    controller.onUpdate(true); // docChanged → user edit
    controller.onUpdate(false); // selection/viewport-only → not dirty
    expect(onDirty).toHaveBeenCalledTimes(1);
  });
});

describe('FactoryEditorController — prefill_idempotent + revert_discards (guarded push)', () => {
  it('setSource pushing a value EQUAL to the doc does NOT dispatch (no clobber, no cursor jump)', () => {
    const controller = new FactoryEditorController(() => {});
    const { view, dispatched } = fakeView('const same = 1;');
    controller.attach(view);
    expect(controller.setSource('const same = 1;')).toBe(false);
    expect(dispatched).toHaveLength(0);
  });

  it('setSource pushing a DIFFERENT value dispatches ONE full-range replace', () => {
    const controller = new FactoryEditorController(() => {});
    const { view, dispatched } = fakeView('const old = 1;');
    controller.attach(view);
    const didDispatch = controller.setSource('const neu = 2;');
    expect(didDispatch).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].changes).toEqual({ from: 0, to: 'const old = 1;'.length, insert: 'const neu = 2;' });
    expect(controller.read()).toBe('const neu = 2;'); // the doc now reflects the push
  });

  it('a programmatic push (Revert/pre-fill) does NOT mark the buffer dirty', () => {
    const onDirty = vi.fn();
    const controller = new FactoryEditorController(onDirty);
    // Wire a controller whose OWN updateListener feeds onUpdate, exactly as the
    // live extension does, so a real docChanged from setSource is exercised.
    const { view } = fakeView('const old = 1;', factoryEditorExtensions(controller));
    controller.attach(view);
    // Simulate the view firing its updateListener for the programmatic change:
    // setSource sets suppressDirty around the dispatch, so onUpdate(true) inside
    // that window must NOT fire onDirty. We assert via the public seam by pushing
    // and then confirming a suppressed docChanged is swallowed.
    const originalDispatch = view.dispatch.bind(view);
    view.dispatch = (spec) => {
      originalDispatch(spec);
      controller.onUpdate(true); // the view would fire this synchronously mid-dispatch
    };
    controller.setSource('const neu = 2;');
    expect(onDirty).not.toHaveBeenCalled();

    // But a subsequent USER edit (onUpdate outside a push) DOES mark dirty.
    controller.onUpdate(true);
    expect(onDirty).toHaveBeenCalledTimes(1);
  });
});
