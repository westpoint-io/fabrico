// @vitest-environment jsdom
//
// keyframeSenders.test.tsx (plan 76-15, review CR-01): what App's senders do on the
// frame a keyframe lands, BEFORE React commits the deselect that keyframe queues.
//
// THE WINDOW. A full keyframe (after an Undo, a Redo, a Load or a New) restarts the
// host's render handles at 0, so a handle the user had selected can name a different
// node on the next frame. App's keyframe branch clears the selection, but React state
// only commits later. Until it does, every control React rendered for the old selection
// is still mounted and still holds the old handle in its closure. Anything that reads
// the selection on that frame (the delete control's per-frame placement, its click) must
// read the LIVE ref the keyframe branch nulls synchronously, not the closure.
//
// WHY jsdom AND A DETACHED ELEMENT. App itself cannot be mounted here (Pixi needs a GL
// context), and React's own rendering never produces the in-between frame in a unit
// test: `act` commits before it returns. So the placement is an exported seam,
// `placeDeleteAnchor`, driven with the two values the window is made of: the node the
// live scene now holds on the handle, and whether the live selection still equals the
// handle React rendered. The real-App half of the same window is
// `frontend/e2e/keyframe-in-between.spec.ts`, which clicks inside it.
//
// Plan 76-16 adds the delete guard's two outcomes (Delete anyway, Drain first). The
// guard's state and outcomes are the exported hook `useDeleteGuard`, mounted here in a
// harness with the real `DeleteGuardDialog`, as App mounts them. The in-between frame is
// produced the way the keyframe branch produces it: `cancelGuard()` runs OUTSIDE act, so
// its state update is only scheduled, and the still-mounted button is clicked before
// React commits.
//
// Plan 76-17 adds the ConfigPanel (review CR-01, threat T-76-44). The panel is mounted
// `key={selectedNode}` and unmounts only when React commits the keyframe's deselect;
// until then its handlers send to the stale handle, and the host accepts a Label config
// onto another label. Every command the panel sends goes through its `sendInput` or
// `sendPortEdit` prop, which App builds with `sendWhileSelected` and
// `portEditWhileSelected` over the live selection epoch (`selectionEpoch.ts`, since the
// 76-17 refuter round; it was the selection ref). Each case mounts the REAL stateful
// `ConfigPanel` over those REAL gates, uses one control while the epoch is still the one
// the panel was rendered for (the positive control), then on a fresh mount runs the
// keyframe branch's `keyframe()` with no React render and uses the same control.

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  placeDeleteAnchor,
  portEditWhileSelected,
  sendWhileSelected,
  useDeleteGuard,
  type DeleteGuardApi,
} from './App.tsx';
import { DeleteGuardDialog } from './DeleteGuardDialog.tsx';
import {
  ConfigPanel,
  disconnectCommand,
  type ConfigInvoke,
  type ConfigPanelProps,
} from './ConfigPanel.tsx';
import { LABEL_TEXT_FIELD_ID } from './LabelConfigBody.tsx';
import { ADD_OUTPUT_LABEL, DISCONNECT_LABEL } from './PortsSection.tsx';
import { PACE_STEPS, paceAccessibleName } from './BeltConfigBody.tsx';
import { portRowLabel } from './portLabels.ts';
import { machine_kind } from '../protocol/kinds.ts';
import { createSelectionEpoch, type SelectionEpoch } from './selectionEpoch.ts';
import { commitConfig } from './ConfigPanel.tsx';
import {
  encodeBeltRunPace,
  encodeGridCommand,
  type MachineConfig,
  type NodeView,
  type PortView,
} from '../protocol/decode.ts';
import type { PortFlow, PortLink } from '../protocol/portFlow.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Roots a guard case mounted, unmounted (inside act) after each case. */
const mounted: { root: Root; container: HTMLDivElement }[] = [];

afterEach(() => {
  // A guard case turns the act environment off to run `cancelGuard()` outside act;
  // restore it before unmounting so the unmount itself is flushed by act.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const m of mounted.splice(0)) {
    act(() => m.root.unmount());
    m.container.remove();
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

/** A one-cell node of `kind` at (cx, cy) on handle 1, the shape the scene map holds. */
const nodeOn1 = (kind: number, cx: number, cy: number): NodeView => ({
  id: 1,
  kind,
  cell_x: cx,
  cell_y: cy,
  state: 0,
  w: 1,
  h: 1,
  rot: 0,
  ports: [],
  load: 0,
  label: null,
});

/** A camera that is neither the identity nor a pure pan, so the projection is exercised. */
const CAM = { x: 10, y: -5, scale: 0.5 };

describe('the delete control on the frame a keyframe lands (CR-01)', () => {
  it('the_delete_control_hides_the_frame_its_handle_is_reminted', () => {
    const el = document.createElement('div');

    // POSITIVE CONTROL: handle 1 is the selected Source at (20,12) and is still the
    // live selection. The anchor is placed at the ring's top-left corner minus the
    // handle offset and the control's size: world (20*32+2, 12*32+2) = (642, 386),
    // screen (642*0.5+10-6-32, 386*0.5-5-6) = (293, 182).
    placeDeleteAnchor(el, CAM, nodeOn1(machine_kind.SOURCE, 20, 12), true);
    expect(
      el.style.visibility,
      'POSITIVE CONTROL: the selected node is still the live selection, so the control is shown',
    ).not.toBe('hidden');
    expect(el.style.transform, 'POSITIVE CONTROL: placed at the ring top-left').toBe(
      'translate(293px, 182px)',
    );

    // The frame the keyframe branch leaves before React commits: the live scene now
    // holds a Label at (2,3) on handle 1, and the live selection is no longer handle 1.
    placeDeleteAnchor(el, CAM, nodeOn1(machine_kind.LABEL, 2, 3), false);
    expect(
      el.style.visibility,
      'the frame a keyframe reminted the selected handle: the delete control is hidden',
    ).toBe('hidden');
    expect(
      el.style.transform,
      'the hidden control is not moved onto the node the keyframe put on the handle',
    ).toBe('translate(293px, 182px)');
  });

  // 76-15 refuter round: a keyframe can also leave NOTHING on the selected handle (an
  // Undo of that machine's Place, a New, a Load of a smaller board). The live scene then
  // holds no node for it, and App passes `undefined`. The anchor must still be hidden,
  // whether or not the ref has been nulled yet: a control for a machine the scene no
  // longer holds has nothing to stand on.
  it('the_delete_control_hides_the_frame_its_handle_names_no_node', () => {
    const el = document.createElement('div');

    // POSITIVE CONTROL: the same placement as above, shown.
    placeDeleteAnchor(el, CAM, nodeOn1(machine_kind.SOURCE, 20, 12), true);
    expect(el.style.visibility, 'POSITIVE CONTROL: shown while the node is selected').toBe(
      'visible',
    );

    placeDeleteAnchor(el, CAM, undefined, false);
    expect(
      el.style.visibility,
      'the frame a keyframe removed the selected node: the delete control is hidden',
    ).toBe('hidden');
    expect(el.style.transform, 'the hidden control is not moved').toBe('translate(293px, 182px)');

    placeDeleteAnchor(el, CAM, nodeOn1(machine_kind.SOURCE, 20, 12), true);
    placeDeleteAnchor(el, CAM, undefined, true);
    expect(
      el.style.visibility,
      'a live selection whose node the scene no longer holds: the delete control is hidden',
    ).toBe('hidden');
    expect(el.style.transform, 'the hidden control is not moved').toBe('translate(293px, 182px)');
  });
});

/** What a guard harness hands back: the hook's live outputs and the commitDelete spy. */
interface GuardHarness {
  api: { current: DeleteGuardApi | null };
  commitDelete: ReturnType<typeof vi.fn<(handle: number) => void>>;
  container: HTMLDivElement;
}

/**
 * Mount the real `useDeleteGuard` with a `commitDelete` spy and a belt read returning
 * `items`, and the real `DeleteGuardDialog` wired from its outputs exactly as App wires
 * it. Runs inside act, so the first render is committed when this returns.
 */
function mountGuard(items: number): GuardHarness {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const api: { current: DeleteGuardApi | null } = { current: null };
  const commitDelete = vi.fn<(handle: number) => void>();
  function Harness(): JSX.Element {
    const g = useDeleteGuard({ commitDelete, beltItems: () => items });
    api.current = g;
    return (
      <DeleteGuardDialog
        open={g.guard !== null}
        itemCount={g.guard?.count ?? 0}
        kind={g.guard?.kind ?? 'machine'}
        draining={g.guard?.draining ?? false}
        onCancel={g.cancelGuard}
        onDrainFirst={g.drainFirst}
        onDeleteAnyway={g.deleteAnyway}
      />
    );
  }
  act(() => root.render(<Harness />));
  return { api, commitDelete, container };
}

/** Open the guard for handle 1 (a machine, belt 3 docked, 2 items), inside act. */
function openGuardOn1(h: GuardHarness): void {
  act(() => h.api.current!.openGuard(1, 2, 'machine', [3]));
}

/** The guard's button named `name` inside the harness, or null. */
function guardButton(h: GuardHarness, name: string): HTMLButtonElement | null {
  return (
    Array.from(h.container.querySelectorAll('button')).find((b) => b.textContent === name) ?? null
  );
}

const dialogOf = (h: GuardHarness): Element | null =>
  h.container.querySelector('[role="alertdialog"]');

/**
 * The keyframe branch's call, made the way the packet handler makes it: OUTSIDE act, so
 * `cancelGuard`'s state update is only scheduled and React has not committed when it
 * returns. Leaves the act environment off until `letReactCommit`.
 */
function cancelGuardOutsideAct(h: GuardHarness): void {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  h.api.current!.cancelGuard();
}

/** Let React commit whatever is scheduled (the scheduler runs on a macrotask). */
async function letReactCommit(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('the delete guard on the frame a keyframe lands (CR-01, WR-06)', () => {
  it('delete_anyway_sends_nothing_after_a_keyframe_cancels_the_guard', async () => {
    // POSITIVE CONTROL: an open guard for handle 1, Delete anyway clicked: one Delete
    // naming handle 1, so a spy that is never called below is not a dead harness.
    const pos = mountGuard(2);
    openGuardOn1(pos);
    const posButton = guardButton(pos, 'Delete anyway');
    expect(posButton, 'POSITIVE CONTROL: the open guard shows Delete anyway').not.toBeNull();
    act(() => posButton!.click());
    expect(
      pos.commitDelete.mock.calls,
      'POSITIVE CONTROL: Delete anyway on an open guard sends one Delete naming handle 1',
    ).toEqual([[1]]);

    // The frame the keyframe branch leaves: the guard cancelled outside act, React not
    // yet committed, the dialog React rendered for handle 1 still mounted.
    const h = mountGuard(2);
    openGuardOn1(h);
    const button = guardButton(h, 'Delete anyway');
    cancelGuardOutsideAct(h);
    expect(
      button?.isConnected,
      'PRECONDITION (React not committed): Delete anyway is still connected when clicked',
    ).toBe(true);
    button!.click();
    expect(
      h.commitDelete.mock.calls,
      'Delete anyway clicked after a keyframe cancelled the guard sends no Delete for handle 1',
    ).toEqual([]);

    await letReactCommit();
    expect(dialogOf(h), 'once React commits, the guard dialog is gone').toBeNull();
    expect(h.commitDelete.mock.calls, 'and still no Delete after the commit').toEqual([]);
  });

  it('drain_first_sends_nothing_after_a_keyframe_cancels_the_guard', async () => {
    // Every drain frame is captured and run by hand, so the drain loop is observable.
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const runFrames = (): void => {
      for (const f of frames.splice(0)) f(0);
    };

    // POSITIVE CONTROL: an open guard for handle 1 whose docked belts read 0 items.
    // Drain first shows the draining readout, and the first drain frame sends one
    // Delete naming handle 1 and closes the dialog.
    const pos = mountGuard(0);
    openGuardOn1(pos);
    const posButton = guardButton(pos, 'Drain first');
    expect(posButton, 'POSITIVE CONTROL: the open guard shows Drain first').not.toBeNull();
    act(() => posButton!.click());
    expect(
      dialogOf(pos)?.textContent ?? '',
      'POSITIVE CONTROL: Drain first shows the draining readout',
    ).toContain('Draining');
    expect(frames.length, 'POSITIVE CONTROL: Drain first requested a drain frame').toBe(1);
    act(() => runFrames());
    expect(
      pos.commitDelete.mock.calls,
      'POSITIVE CONTROL: the drain reaching zero sends one Delete naming handle 1',
    ).toEqual([[1]]);
    expect(dialogOf(pos), 'POSITIVE CONTROL: the drained guard closes').toBeNull();

    // The frame the keyframe branch leaves, with the same 0-item belts.
    const h = mountGuard(0);
    openGuardOn1(h);
    const button = guardButton(h, 'Drain first');
    cancelGuardOutsideAct(h);
    expect(
      button?.isConnected,
      'PRECONDITION (React not committed): Drain first is still connected when clicked',
    ).toBe(true);
    button!.click();

    await letReactCommit();
    runFrames();
    await letReactCommit();
    expect(
      h.commitDelete.mock.calls,
      'Drain first clicked after a keyframe cancelled the guard: no drain loop sends a Delete for handle 1',
    ).toEqual([]);
    expect(
      dialogOf(h),
      'once React commits, the guard dialog is gone and not back as draining',
    ).toBeNull();
  });
});


// ---- the ConfigPanel's sends on the frame a keyframe lands (plan 76-17, CR-01) ---------

/** A label's committed config on handle 1. */
const LABEL_CFG: Extract<MachineConfig, { kind: 'Label' }> = {
  kind: 'Label',
  text: 'Before',
  colour: 0,
  w: 3,
  h: 1,
};

/** A belt's committed config on handle 1: the shipped pace, 2 ticks per slot. */
const BELT_CFG: Extract<MachineConfig, { kind: 'Belt' }> = { kind: 'Belt', ticks_per_slot: 2 };

/** The catalog Factory's three ports (In 0, Out 1, Fault 2), on handle 1 at (10,8). */
const FACTORY_PORTS: PortView[] = [
  { index: 0, cell_x: 10, cell_y: 9, side: 3, role: 0, medium: 0 },
  { index: 1, cell_x: 12, cell_y: 9, side: 1, role: 1, medium: 0 },
  { index: 2, cell_x: 11, cell_y: 10, side: 2, role: 2, medium: 0 },
];

/** Belt 5's Tail docked on the Out port (index 1). */
const OUT_LINK: PortLink = { kind: 'belt', belt: 5, end: 'Tail' };

/** The live flow with belt 5 docked on the Out port, so its row offers Disconnect. */
const DOCKED_FLOW = (): Map<number, PortFlow> =>
  new Map([[1, { docked: true, carrying: false, backedUp: false, link: OUT_LINK }]]);

type SendInputSpy = ReturnType<typeof vi.fn<(bytes: Uint8Array) => void>>;
type PortEditSpy = ReturnType<typeof vi.fn<ConfigPanelProps['sendPortEdit']>>;

/** What a panel harness hands back: the live selection epoch the gates read and the seam spies. */
interface PanelHarness {
  epoch: SelectionEpoch;
  sendInput: SendInputSpy;
  sendPortEdit: PortEditSpy;
  container: HTMLDivElement;
}

/**
 * Mount the real stateful `ConfigPanel` for handle 1 as App mounts it: its `sendInput`
 * and `sendPortEdit` are the real `sendWhileSelected` and `portEditWhileSelected` over a
 * real selection epoch (`selectionEpoch.ts`) that has just announced node 1, with the
 * epoch that announcement produced as the panel's subject, forwarding to spies. `invoke` answers `machine_config` with `config`.
 * Resolves once the config round trip has been applied.
 */
async function mountPanel(
  kind: number,
  config: MachineConfig | null,
  extra: Partial<ConfigPanelProps> = {},
): Promise<PanelHarness> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const epoch = createSelectionEpoch();
  const subject = epoch.node(1);
  epoch.belt(null);
  const sendInput: SendInputSpy = vi.fn<(bytes: Uint8Array) => void>();
  const sendPortEdit: PortEditSpy = vi.fn<ConfigPanelProps['sendPortEdit']>(() => true);
  const invoke: ConfigInvoke = (cmd) =>
    Promise.resolve(cmd === 'machine_config' ? config : undefined);
  act(() =>
    root.render(
      <ConfigPanel
        node={1}
        kind={kind}
        sendInput={sendWhileSelected(epoch, subject, sendInput)}
        sendPortEdit={portEditWhileSelected(epoch, subject, sendPortEdit)}
        invoke={invoke}
        ports={[]}
        addBlockedByBelt={false}
        flow={new Map()}
        run={[]}
        otherRoutes={[]}
        playing={true}
        portEditPending={false}
        portEditStalled={false}
        portEditPendingVisible={false}
        onPortEditReset={() => {}}
        {...extra}
      />,
    ),
  );
  // The config round trip resolves on a microtask; let React apply it.
  for (let i = 0; i < 5; i++) await act(async () => {});
  return { epoch, sendInput, sendPortEdit, container };
}

/** The panel's button whose accessible name (aria-label, else text) is `name`. */
function panelButton(h: PanelHarness, name: string): HTMLButtonElement {
  const b = Array.from(h.container.querySelectorAll('button')).find(
    (x) => (x.getAttribute('aria-label') ?? x.textContent) === name,
  );
  expect(b, `PRECONDITION: the panel shows the ${name} control`).toBeDefined();
  expect(b!.disabled, `PRECONDITION: the ${name} control is enabled`).toBe(false);
  return b!;
}

/** Type `value` into the label's Text field the way a keystroke reaches React. */
function typeLabelText(h: PanelHarness, value: string): void {
  const field = h.container.querySelector(`#${LABEL_TEXT_FIELD_ID}`);
  expect(field, 'PRECONDITION: the label panel shows its Text field').toBeInstanceOf(
    HTMLTextAreaElement,
  );
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    set.call(field, value);
    field!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/**
 * The frame the keyframe branch leaves: its own `liveEpoch.keyframe()` line, run
 * synchronously and with no React render, so the panel React rendered for handle 1 is
 * still mounted. Only that line: the selection-clear announcements that follow it in App
 * would move the epoch too, and leaving them out is what lets these cases prove the
 * keyframe line closes the panel on its own.
 */
function keyframeClearsSelection(h: PanelHarness): void {
  h.epoch.keyframe();
}

/** Click `button` and let any send the click scheduled run. */
async function use(button: HTMLButtonElement): Promise<void> {
  act(() => button.click());
  await act(async () => {});
}

/** Where a port edit was sent: the node it names and its kind. */
const portEditTargets = (spy: PortEditSpy): [number, string][] =>
  spy.mock.calls.map((c) => [c[0], c[1]]);

/** The Out port's row name, as the Disconnect control's accessible name spells it. */
const DISCONNECT_OUT = `${DISCONNECT_LABEL} ${portRowLabel(FACTORY_PORTS[1])}`;

describe('the config panel on the frame a keyframe lands (CR-01, T-76-44)', () => {
  it('a_label_apply_sends_nothing_once_the_keyframe_cleared_the_selection', async () => {
    const edited: MachineConfig = { ...LABEL_CFG, text: 'After' };

    // POSITIVE CONTROL: the label panel for handle 1, its Text edited, Apply clicked
    // while the ref still holds 1: one Configure naming handle 1 with the edited words.
    const pos = await mountPanel(machine_kind.LABEL, LABEL_CFG);
    typeLabelText(pos, 'After');
    await use(panelButton(pos, 'Apply'));
    expect(
      pos.sendInput.mock.calls,
      'POSITIVE CONTROL: Apply on a label panel sends one Configure naming handle 1',
    ).toEqual([[encodeGridCommand({ kind: 'Configure', node: 1, config: edited })]]);

    // The frame the keyframe branch leaves, on a fresh mount.
    const h = await mountPanel(machine_kind.LABEL, LABEL_CFG);
    typeLabelText(h, 'After');
    const apply = panelButton(h, 'Apply');
    keyframeClearsSelection(h);
    await use(apply);
    expect(
      h.sendInput.mock.calls,
      'a label Apply clicked after the keyframe cleared the selection sends no Configure for handle 1',
    ).toEqual([]);
  });

  it('add_output_sends_nothing_once_the_keyframe_cleared_the_selection', async () => {
    // POSITIVE CONTROL: a Factory panel for handle 1, `+ Add output` clicked: one
    // AddPort through the port-edit seam, naming handle 1.
    const pos = await mountPanel(machine_kind.FACTORY, null, { ports: FACTORY_PORTS });
    await use(panelButton(pos, ADD_OUTPUT_LABEL));
    expect(
      portEditTargets(pos.sendPortEdit),
      'POSITIVE CONTROL: Add output sends one port edit naming handle 1',
    ).toEqual([[1, 'add']]);

    const h = await mountPanel(machine_kind.FACTORY, null, { ports: FACTORY_PORTS });
    const add = panelButton(h, ADD_OUTPUT_LABEL);
    keyframeClearsSelection(h);
    await use(add);
    expect(
      h.sendPortEdit.mock.calls,
      'Add output clicked after the keyframe cleared the selection sends no AddPort for handle 1',
    ).toEqual([]);
  });

  it('remove_output_sends_nothing_once_the_keyframe_cleared_the_selection', async () => {
    // POSITIVE CONTROL: the Factory's Remove on its Out row: one RemovePort naming 1.
    const pos = await mountPanel(machine_kind.FACTORY, null, { ports: FACTORY_PORTS });
    await use(panelButton(pos, 'Remove output 1'));
    expect(
      portEditTargets(pos.sendPortEdit),
      'POSITIVE CONTROL: Remove sends one port edit naming handle 1',
    ).toEqual([[1, 'remove']]);

    const h = await mountPanel(machine_kind.FACTORY, null, { ports: FACTORY_PORTS });
    const remove = panelButton(h, 'Remove output 1');
    keyframeClearsSelection(h);
    await use(remove);
    expect(
      h.sendPortEdit.mock.calls,
      'Remove clicked after the keyframe cleared the selection sends no RemovePort for handle 1',
    ).toEqual([]);
  });

  it('disconnect_sends_nothing_once_the_keyframe_cleared_the_selection', async () => {
    const docked = { ports: FACTORY_PORTS, flow: DOCKED_FLOW() };

    // POSITIVE CONTROL: the docked Out row's Disconnect: one Unlink naming handle 1.
    const pos = await mountPanel(machine_kind.FACTORY, null, docked);
    await use(panelButton(pos, DISCONNECT_OUT));
    expect(
      pos.sendInput.mock.calls,
      'POSITIVE CONTROL: Disconnect sends one Unlink naming handle 1',
    ).toEqual([[encodeGridCommand(disconnectCommand(1, FACTORY_PORTS[1], OUT_LINK))]]);

    const h = await mountPanel(machine_kind.FACTORY, null, {
      ports: FACTORY_PORTS,
      flow: DOCKED_FLOW(),
    });
    const disconnect = panelButton(h, DISCONNECT_OUT);
    keyframeClearsSelection(h);
    await use(disconnect);
    expect(
      h.sendInput.mock.calls,
      'Disconnect clicked after the keyframe cleared the selection sends no Unlink for handle 1',
    ).toEqual([]);
  });

  it('a_belt_pace_apply_sends_nothing_once_the_keyframe_cleared_the_selection', async () => {
    const slower = PACE_STEPS[1];
    const run = [{ id: 1, ticksPerSlot: BELT_CFG.ticks_per_slot }];

    // POSITIVE CONTROL: the belt panel for handle 1, a slower pace pressed, Apply
    // clicked: one run-pace frame naming belt 1.
    const pos = await mountPanel(machine_kind.BELT, BELT_CFG, { run });
    await use(panelButton(pos, paceAccessibleName(slower.label)));
    await use(panelButton(pos, 'Apply'));
    expect(
      pos.sendInput.mock.calls,
      'POSITIVE CONTROL: a belt pace Apply sends one run-pace frame naming belt 1',
    ).toEqual([[encodeBeltRunPace([1], slower.ticks)]]);

    const h = await mountPanel(machine_kind.BELT, BELT_CFG, { run });
    await use(panelButton(h, paceAccessibleName(slower.label)));
    const apply = panelButton(h, 'Apply');
    keyframeClearsSelection(h);
    await use(apply);
    expect(
      h.sendInput.mock.calls,
      'a belt pace Apply clicked after the keyframe cleared the selection sends no run-pace frame',
    ).toEqual([]);
  });
});

// ---- the same handle number, selected again (the 76-17 refuter round, CR-01, T-76-44) ---
//
// Plan 76-17's gates compared the selected HANDLE, and a keyframe remints handles, so the
// number can come back naming a different node: the keyframe clears the selection, the
// user selects the node now on handle 1, and the gate saw 1 === 1. A Factory Apply awaits
// `validate_factory_js` before it sends, so its continuation could run after that reselect
// and send Factory A's source onto Factory B. App now gates on the selection epoch. These
// cases drive the real `commitConfig` through the real `sendWhileSelected` over a real
// epoch, announcing exactly what App's handlers announce (`onSelect`, `onSelectBelt`, the
// keyframe branch). A Factory panel needs CodeMirror, which jsdom cannot host, so the
// commit is driven directly; the real-App half is the Factory leg in
// `frontend/e2e/keyframe-in-between.spec.ts`.

/** A `validate_factory_js` answer the case releases by hand, and the invoke that holds it. */
function heldValidate(): { invoke: ConfigInvoke; release(): void; asked: () => number } {
  let release = (): void => {
    throw new Error('validate_factory_js was never asked');
  };
  let asked = 0;
  const invoke: ConfigInvoke = (cmd) => {
    if (cmd !== 'validate_factory_js') return Promise.resolve(undefined);
    asked += 1;
    return new Promise((resolve) => {
      release = () => resolve(null);
    });
  };
  return { invoke, release: () => release(), asked: () => asked };
}

const FACTORY_A: Extract<MachineConfig, { kind: 'Factory' }> = {
  kind: 'Factory',
  source: 'export default (payload) => payload; // Factory A, edited',
};

describe('a Factory Apply validating across a keyframe and a reselect of its handle (CR-01, T-76-44)', () => {
  it('a_factory_apply_sends_nothing_once_a_keyframe_and_a_reselect_of_handle_1_ran_during_validate', async () => {
    // POSITIVE CONTROL: Factory A selected on handle 1, its Apply validating, the user
    // clicks A again (App re-announces the same node), validate answers: one Configure
    // naming handle 1, carrying A's source. Clicking the selected machine again keeps it.
    {
      const epoch = createSelectionEpoch();
      const subject = epoch.node(1);
      epoch.belt(null);
      const send = vi.fn<(bytes: Uint8Array) => void>();
      const v = heldValidate();
      const p = commitConfig(1, FACTORY_A, {
        invoke: v.invoke,
        sendInput: sendWhileSelected(epoch, subject, send),
        run: [],
      });
      expect(v.asked(), 'PRECONDITION: the Apply is waiting on validate_factory_js').toBe(1);
      epoch.node(1);
      epoch.belt(null);
      v.release();
      await p;
      expect(
        send.mock.calls,
        'POSITIVE CONTROL: with A still selected the Apply sends one Configure naming handle 1',
      ).toEqual([[encodeGridCommand({ kind: 'Configure', node: 1, config: FACTORY_A })]]);
    }

    // THE DEFECT SHAPE: the same Apply, and while validate is in flight a keyframe
    // remints handle 1 onto Factory B (the keyframe branch: `keyframe()`, then the
    // selection clear announces null on both channels) and the user selects B, which now
    // holds handle 1 (`onSelect(1)`, `onSelectBelt(null)`). Then validate answers.
    const epoch = createSelectionEpoch();
    const subject = epoch.node(1);
    epoch.belt(null);
    const send = vi.fn<(bytes: Uint8Array) => void>();
    const v = heldValidate();
    const p = commitConfig(1, FACTORY_A, {
      invoke: v.invoke,
      sendInput: sendWhileSelected(epoch, subject, send),
      run: [],
    });
    expect(v.asked(), 'PRECONDITION: the Apply is waiting on validate_factory_js').toBe(1);
    epoch.keyframe();
    epoch.node(null);
    epoch.belt(null);
    epoch.node(1);
    epoch.belt(null);
    v.release();
    await p;
    expect(
      send.mock.calls,
      "Factory A's Apply, validating when the keyframe landed, sends nothing onto the node now on handle 1",
    ).toEqual([]);
  });
});

// Phase 89 UI review UI-01: the floating control never covers a warning ring. The rings are the
// PLOTTED centres App reads off the ring Graphics, in world px.
describe('the delete control steps off a warning ring (UI-01)', () => {
  const CAM1 = { x: 0, y: 0, scale: 1 };
  // A Source at (20,12): its ring spans world (642, 386) to (670, 414).
  const SOURCE = nodeOn1(machine_kind.SOURCE, 20, 12);

  it('with no ring the control sits where it always did, beside the top-left corner', () => {
    const el = document.createElement('div');
    placeDeleteAnchor(el, CAM1, SOURCE, true, []);
    expect(el.style.transform).toBe('translate(604px, 380px)');
  });

  it('a ring on the cut belt end left of the machine moves it under the bottom-left corner', () => {
    // The tile left of the Source, (19,12), centre (624, 400): inside the shipped square
    // (604..636, 380..412), the walk's crop-s6 picture.
    const el = document.createElement('div');
    placeDeleteAnchor(el, CAM1, SOURCE, true, [{ x: 624, y: 400 }]);
    expect(el.style.transform).toBe('translate(636px, 420px)');
  });

  it('a second ring below moves it over the top-left corner, and a ring nowhere near moves nothing', () => {
    const el = document.createElement('div');
    placeDeleteAnchor(el, CAM1, SOURCE, true, [
      { x: 624, y: 400 },
      { x: 656, y: 432 },
    ]);
    expect(el.style.transform).toBe('translate(636px, 348px)');
    placeDeleteAnchor(el, CAM1, SOURCE, true, [{ x: 900, y: 900 }]);
    expect(el.style.transform).toBe('translate(604px, 380px)');
  });

  it('with every place covered it stays where it always was', () => {
    const el = document.createElement('div');
    placeDeleteAnchor(el, CAM1, SOURCE, true, [
      { x: 624, y: 400 },
      { x: 656, y: 432 },
      { x: 656, y: 364 },
      { x: 692, y: 400 },
    ]);
    expect(el.style.transform).toBe('translate(604px, 380px)');
  });
});
