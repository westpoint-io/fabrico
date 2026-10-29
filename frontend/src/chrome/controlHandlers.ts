// controlHandlers.ts — the real Toolbar/gesture control handlers (18-05, CLEAN-04).
//
// Every affordance the user can click (Play/Pause, Step, Save, Load, Load-demo)
// routes to a real host command through `ITransport.sendControl`. There is NO
// stub / no-op path left. Save/Load first obtain a path:
//   - under Tauri: the native dialog (tauri-plugin-dialog save()/open()) — its
//     module is imported DYNAMICALLY and ONLY on the Tauri branch, so the dev
//     build never evaluates the Tauri-only symbols (T-18-FE-DIALOG-IMPORT).
//   - under the dev browser path: a dev-only `window.prompt` fallback, so the
//     18-06 browser gate can exercise Save/Load too.
//
// The path then rides `sendControl('save'|'load', path)` to the transport, which
// hands it to the hardened Rust command that owns the bytes (fs:* withheld,
// 18-04 / T-18-FE-PATH). The handlers NEVER mutate the grid locally (SC5).

import { type ITransport, detectEnv } from '../transport/transport';

/**
 * The honest Save/Load feedback states (SHELL-07). The status readout observes
 * ONLY the existing render stream - there is deliberately NO host-confirmed Save
 * success kind, because the host sends no write-result echo (that would need a
 * new Rust host control-echo, DEFERRED - out of "skin, not skeleton" scope). The
 * honest ceiling for Save is `saveRequested` (dispatch-confirmed only).
 */
export type StatusKind =
  | 'idle'
  | 'saveRequested'
  | 'loading'
  | 'loaded'
  | 'saveFailed'
  | 'loadFailed'
  // SAFE-01: a STICKY system-fault kind for a dropped render stream. It is NOT
  // in the statusMachine auto-clear set (statusMachine.ts) - it persists until a
  // packet reconnects. Set DIRECTLY by the playing-gated stall watchdog (never
  // through statusMachine.apply), so it overlays whatever was showing without
  // clobbering an in-flight load latch, and clears back to 'idle' on reconnect.
  | 'disconnected'
  // A TRANSIENT CLIENT-ORIGINATED kind: an edit reached the transport while the
  // sim was not Playing. `SimLoop::step` calls `acquire_input()` only in the
  // `RunState::Playing` arm, over an UNBOUNDED gesture channel - so the edit is
  // held and applied on resume, unless a board swap (New, an example, Open)
  // discards it first: the host drops every edit queued on the board a swap
  // replaces (plan 74.1-35, review round 5 CR-01), so it never lands on the new
  // board. A refused Open swaps nothing and keeps it queued. Unlike
  // `disconnected` this IS in the statusMachine auto-clear set, so it fades back
  // to idle after STATUS_AUTOCLEAR_MS and re-arms on the next queued edit.
  | 'editsQueued'
  // Plan 74.1-31 (PAUSE-TOOLBAR): a TRANSIENT CLIENT-ORIGINATED kind, the same tier as
  // `editsQueued`. An Undo or Redo was pressed while edits made on a paused board had not
  // landed, so App sent nothing (an Undo queued behind a paused draw deleted that belt on
  // Play, with no message, on the third re-walk). It says what to do instead.
  | 'undoHeld'
  // Phase 90 (FAIL-01, D-12): the host's sim loop ended and will not come back. A HOST FACT,
  // not a client guess, so it is STICKY and HIGHEST: once set nothing clears it (no auto-clear
  // timer, no stall watchdog, no later `apply`), and it outranks every other kind, `loading`
  // included (a latched load is dropped). Its copy is generic; the host's reason goes to the
  // stopped card only (T-32-06-01).
  | 'simStopped';

/**
 * The GENERIC display copy per status kind. It NEVER contains the raw file path
 * (threat T-32-06-01: echoing the path into the aria-live region would leak
 * filesystem structure into the a11y tree). The Save-resolved value is exactly
 * the honest dispatch-confirmed ceiling `Save requested` - there is NO
 * host-confirmed "Saved" string anywhere in this map (Phase 30/31 honesty
 * lineage). `idle` renders nothing (the live region persists but empty).
 */
export const STATUS_COPY: Record<StatusKind, string> = {
  idle: '',
  saveRequested: 'Save requested',
  loading: 'Loading…',
  loaded: 'Loaded',
  saveFailed: 'Save failed',
  loadFailed: 'Load failed',
  // SAFE-01: GENERIC copy - never a path/detail into the aria-live region
  // (T-32-06-01). Hyphen, no em dash. The frozen board is honestly labelled
  // stale rather than passing as live.
  disconnected: 'Disconnected - live view frozen',
  // GENERIC copy - no cell coordinate, no node handle, no path into the aria-live
  // region (T-32-06-01), and no interpolation at all. Hyphen, no em dash.
  //
  // The sentence is TRUE, which is the whole point of it: the host really does
  // hold the edit on its unbounded gesture channel and really does apply it when
  // the sim resumes. So it must never be worded as ignored, discarded or refused
  // - the user would then believe a lie in the other direction and re-issue an
  // edit that was already queued.
  //
  // Why this tier and NOT RefusalMessage.tsx: that surface is verdict-driven over
  // a CLOSED 17-tag host union and its own docblock says the client does not
  // invent causes there (T-64-06-01). Being paused is a fact the client knows
  // about ITSELF, not a verdict the host issued, so it belongs here.
  //
  // The wording is the SHORT one, and that was a MEASURED choice, not a taste
  // call. On a dirty board at 1106px the `.fab-cta` right edge reads 1068px with
  // an empty readout, 1336px under this map's previously-widest string
  // (`Disconnected - live view frozen`, 31 chars), and 1436px under the 46-char
  // long form `Paused - edits are queued until you press Play`. The readout is
  // `whiteSpace: 'nowrap'` in the header flex row, so a status string pushes that
  // row wider by roughly its own width. At 32 chars this sentence measures 1324px
  // - 12px INSIDE the worst case the app already ships - so it sets no new layout
  // worst case, where the long form would have set one 100px worse.
  editsQueued: 'Paused - edits queued until Play',
  // Plan 74.1-31: GENERIC copy like `editsQueued` (no handle, no path, T-32-06-01), and
  // TRUE: nothing was sent, and Play is what lets the queued edits land so Undo can act
  // on them. 39 characters (python3 len()), the longest in this map; it renders in the
  // status strip under the toolbar, out of the button row, so its width moves nothing.
  // Hyphen, no em dash.
  undoHeld: 'Paused - press Play before undo or redo',
  // Phase 90 (FAIL-01, D-12): GENERIC copy (no reason, no path, T-32-06-01), and never worded
  // as a connection that may come back: the simulation stopped, and nothing restarts it. 18
  // characters, shorter than `Disconnected - live view frozen`, so it sets no new strip width.
  simStopped: 'Simulation stopped',
};

/** The control handlers the App wires into the gesture layer + the Toolbar. */
export interface ControlHandlers {
  onPlayPause: () => void;
  onStep: () => void;
  /**
   * SAVE-03 smart-Save. With a known current path (and no `saveAs` force) it
   * re-saves to that path with NO dialog (the desktop convention). When `saveAs`
   * is true (Shift-click / Ctrl+Shift+S) it ALWAYS prompts, bypassing the known
   * path. When no path is known it falls to the prompt (Save-As fallback).
   *
   * BL-01: resolves a CONFIRMED-write signal so a caller can gate a destructive
   * continuation on it. `true` == a genuine dispatch happened (the honest
   * `saveRequested` ceiling); `false` == the user cancelled the dialog (`idle`)
   * or the write failed (`saveFailed`). The discard guard's Save-then-proceed
   * consumes this so a cancelled/failed Save never discards the board; the
   * Toolbar Save button and the keyboard shortcut ignore the value.
   */
  onSave: (saveAs?: boolean) => Promise<boolean>;
  onLoad: () => void | Promise<void>;
  onLoadDemo: () => void;
}

/** Injectable seams — App supplies transport + playing state; tests supply fakes. */
export interface ControlHandlerDeps {
  /** The live transport (may be null before boot resolves — handlers no-op then). */
  transport: ITransport | null;
  /** Read the latest optimistic `playing` value (drives pause vs resume). */
  isPlaying: () => boolean;
  /** Flip the optimistic `playing` state (the Play/Pause glyph reflects this). */
  setPlaying: (next: boolean) => void;
  /** True under Tauri (native dialog); false in the dev browser (prompt). */
  hasTauri?: boolean;
  /** Dev-only path prompt; defaults to `window.prompt`. */
  promptPath?: (message: string) => string | null;
  /** Tauri native "save" dialog; default lazily imports the plugin. */
  pickSavePath?: () => Promise<string | null>;
  /** Tauri native "open" dialog; default lazily imports the plugin. */
  pickLoadPath?: () => Promise<string | null>;
  /**
   * SAVE-03 smart-Save seam. Reads the CURRENT known file path (App wires this to
   * `currentFilePathRef`, written by a Save-As pick and by Open in Plan 03).
   * `null`/absent means "no known path" -> plain Save falls to the dialog. The
   * path is used ONLY to route the dispatch; it NEVER crosses into a status/label
   * string (T-32-06-01).
   */
  currentPath?: () => string | null;
  /**
   * SAVE-03: report the path the user chose in a Save-As dialog so App can update
   * `currentFilePathRef` (making a subsequent plain Save a no-dialog re-save).
   * Fired ONLY when a dialog/prompt actually resolved a fresh path.
   */
  onPathChosen?: (path: string) => void;
  /**
   * Phase 90 (WORK-07, D-02): report the path of a DISPATCHED Open. App holds it as a
   * pending load and makes it the save target only when the host confirms the Load (its
   * swap keyframe); a refused or superseded Load never moves the target. Fired after the
   * dispatch succeeds, before `onStatus('loading')`. Never `onPathChosen`, which stays the
   * Save-As pick.
   */
  onLoadDispatched?: (path: string) => void;
  /**
   * SHELL-07 honest feedback seam. Optional (absent = no-op) so the smoke tests
   * that ignore feedback stay unchanged. Emits KIND enums only, NEVER a path
   * string. Load stays `loading` here and resolves to `loaded` in the App on the
   * Load's own swap keyframe (`isLoadSwap`, phase 90 D-06), never on an Undo's.
   */
  onStatus?: (kind: StatusKind) => void;
  /**
   * Phase 90 review WR-B-04: has the host's sim loop ended? Read again AFTER the native Save As
   * or Open dialog resolves, because the dialog can stay open across the fatal: an answer that
   * comes after the stop sends nothing and reports nothing. Absent: never stopped.
   */
  isStopped?: () => boolean;
}

const FAB_FILTER = { name: 'Fabrico', extensions: ['fab'] };

/** Default Tauri save dialog — imported ONLY when invoked on the Tauri branch. */
async function defaultPickSavePath(): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  // SAVE-03: seed the native dialog with the desktop-convention suggested name
  // `untitled.fab` (only used when no known path exists — a known path re-saves
  // with no dialog). The .fab filter keeps the picker scoped to project files.
  return await save({ defaultPath: 'untitled.fab', filters: [FAB_FILTER] });
}

/** Default Tauri open dialog — imported ONLY when invoked on the Tauri branch. */
async function defaultPickLoadPath(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ filters: [FAB_FILTER], multiple: false });
  return typeof picked === 'string' ? picked : null;
}

/** Default dev-browser prompt fallback (loopback dev convenience only). */
function defaultPromptPath(message: string): string | null {
  return typeof window !== 'undefined' ? window.prompt(message) : null;
}

/**
 * Build the real control handlers. Pure over its injected deps — the App creates
 * these each render with the fresh `playing` value; the smoke test drives them
 * with a fake transport that records the `sendControl` calls (CLEAN-04).
 */
export function makeControlHandlers(deps: ControlHandlerDeps): ControlHandlers {
  const {
    transport,
    isPlaying,
    setPlaying,
    hasTauri = detectEnv().hasTauri,
    promptPath = defaultPromptPath,
    pickSavePath = defaultPickSavePath,
    pickLoadPath = defaultPickLoadPath,
    currentPath,
    onPathChosen,
    onLoadDispatched,
    onStatus,
    isStopped = () => false,
  } = deps;

  return {
    // Optimistic flip: the glyph reflects the click immediately; the sim state is
    // otherwise inferable from tick-progress (settled vs still-draining) with NO
    // schema/IPC status field (Open Q3 / HOST-02 frontend side).
    onPlayPause: (): void => {
      const next = !isPlaying();
      setPlaying(next);
      transport?.sendControl(next ? 'resume' : 'pause');
    },
    // D-07 (phase 90, FAIL-03): a Step on a playing board pauses the page FIRST, then sends
    // `step` alone. The host runs one tick and holds (and records the Step as the user's own
    // hold), so the page must stop believing it plays: otherwise the transport keeps reading
    // Pause over a board that no longer moves and the stall watchdog calls the silence a
    // dropped stream. Never `pause` then `step`: two host calls carry no ordering contract.
    onStep: (): void => {
      if (isPlaying()) setPlaying(false);
      transport?.sendControl('step');
    },
    onSave: async (saveAs?: boolean): Promise<boolean> => {
      // SAVE-03 smart-Save: with a known current path and no forced Save-As,
      // re-save straight to it (NO dialog) — the desktop re-save convention.
      const known = currentPath?.() ?? null;
      if (known && !saveAs) {
        try {
          transport?.sendControl('save', known);
          onStatus?.('saveRequested');
          // BL-01: a genuine, dispatch-confirmed write. Report success so the
          // discard guard's Save-then-proceed may run its destructive continuation.
          return true;
        } catch {
          onStatus?.('saveFailed');
          // BL-01: a failed write must NOT let the caller discard the board.
          return false;
        }
      }
      // Save-As (forced, or no known path): prompt for a fresh path. Native
      // dialog under Tauri, dev-only prompt otherwise. MD-01: the native dialog
      // can REJECT (plugin error); wrap the pick so a rejection resolves to a
      // clean `false` (Save failed) instead of an unhandled rejection that would
      // strand a pending New/Open. This also hardens the plain Toolbar Save.
      let path: string | null;
      try {
        path = hasTauri
          ? await pickSavePath()
          : promptPath('Save factory to path (.fab):');
      } catch {
        onStatus?.('saveFailed');
        return false;
      }
      // WR-B-04: the fatal may have arrived while the dialog was open. The board can no longer be
      // saved, so nothing is sent and no status claims it was.
      if (isStopped()) return false;
      if (path) {
        try {
          // IN-01: no 'saving' pre-emit — it was synchronously superseded by
          // 'saveRequested' in the same tick (React batches), so it NEVER
          // rendered. Emitting it implied feedback that never painted. Settle
          // directly at the honest ceiling.
          transport?.sendControl('save', path);
          // SAVE-03: record the chosen path so the next plain Save re-saves to it
          // with no dialog. Reported as a KIND-free callback (App writes the ref);
          // the path is never interpolated into a status string (T-32-06-01).
          onPathChosen?.(path);
          // Dispatch-confirmed ONLY: the host sends no write-result echo, so the
          // honest ceiling is 'Save requested', NEVER a host-confirmed 'Saved'
          // (SHELL-07 scope guard; host-confirm is DEFERRED).
          onStatus?.('saveRequested');
          // BL-01: confirmed dispatch -> the destructive continuation may proceed.
          return true;
        } catch {
          onStatus?.('saveFailed');
          return false;
        }
      }
      // Dialog cancelled (falsy path) - no command dispatched (SC5). A
      // deliberate cancel is NOT a failure: emit `idle` (no announcement),
      // reserving `saveFailed` for the catch block where sendControl throws
      // (WR-01 honesty; SHELL-07). BL-01: return false so a cancelled Save
      // never proceeds to discard the board.
      onStatus?.('idle');
      return false;
    },
    onLoad: async (): Promise<void> => {
      // MD-01: mirror onSave - a rejected native Open dialog must abort safely
      // (board unchanged, pending action dropped), never an unhandled rejection.
      let path: string | null;
      try {
        path = hasTauri
          ? await pickLoadPath()
          : promptPath('Load factory from path (.fab):');
      } catch {
        onStatus?.('loadFailed');
        return;
      }
      // WR-B-04: as for Save As, an Open answered after the stop does nothing.
      if (isStopped()) return;
      if (path) {
        try {
          transport?.sendControl('load', path);
          // SAVE-05 / D-02 (phase 90): the opened path becomes the smart-Save target only
          // when the host confirms the Load. It is reported as a DISPATCHED Load; App holds
          // it as pending and moves currentFilePathRef on the Load's own swap keyframe, so
          // a refused file never becomes the file Ctrl+S writes. Reported KIND-free; the
          // path is NEVER interpolated into a status string (T-32-06-01). Fired only after
          // the dispatch succeeds, so a throwing Load records nothing.
          onLoadDispatched?.(path);
          // WR-02: emit 'loading' ONLY after the dispatch succeeds, so a throwing Load
          // that never reached the host latches nothing. Mirrors onSave, which emits
          // 'saveRequested' only AFTER a successful sendControl. The dirty flag and the
          // "Demo scene" badge do not move here (phase 90, D-02, review WR-B-06): App
          // clears them on the Load's own swap keyframe (`isLoadSwap`). 'loading' then
          // stays until that keyframe resolves 'loaded', a refusal reads 'loadFailed',
          // or the host stops answering (the status machine's cut-off). We do NOT emit
          // 'loaded' here: a dispatch is not a swap.
          onStatus?.('loading');
        } catch {
          onStatus?.('loadFailed');
        }
      } else {
        // Dialog cancelled (falsy path) - a deliberate cancel is NOT a failure:
        // emit `idle` (no announcement), reserving `loadFailed` for the catch
        // block where sendControl throws (WR-01 honesty; SHELL-07).
        onStatus?.('idle');
      }
    },
    onLoadDemo: (): void => {
      transport?.sendControl('loadDemo');
    },
  };
}
