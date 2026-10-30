// liveWaitCaps.ts - every wall-clock cap in the live suite, and which wait each is around.
//
// Users: `liveWaitCaps.source.test.ts` (the gate, on every `npm test`) and
// `scripts/list-live-wait-caps.ts` (the lister, one `CAP` row per site). Both read the live
// suite AS SOURCE with the TypeScript compiler API; neither imports a spec or runs Playwright.
//
// WHY (plan 84-18, D-12). CI draws the live pages at about 5 frames a second, and the GPU proxy
// at 4.5 to 5.0. Ruling D-12 restates the WALL-CLOCK cap around every FRAME-BOUND wait,
// derived from the frames the wait needs (`frameBudgetMs`, `tickBudgetMs`, `addWaitBudget`),
// never picked; a cap on a model, DOM or IO wait keeps plans 84-08 and 84-09's rule and is left
// alone. Plan 84-13's inventory was taken by hand and missed three caps around screen captures,
// found one proxy pass at a time (84-17). This module finds them mechanically.
//
// SITES (in `e2e-live/**/*.ts` only; `e2e/support/frameSampler.ts` is read for its functions):
//   - a `timeout` property in an object literal passed to a call: kind `poll` (`expect.poll`),
//     `matcher` (a `to...` assertion), `waitFor` (a locator or page wait), `pageWait`
//     (`waitForFunction`), `scene` (`pollScene`) or `option` (any other call's options);
//   - a test limit, `test.setTimeout(...)`, `test.info().setTimeout(...)` or
//     `testInfo.setTimeout(...)` (kind `testLimit`);
//   - the cap argument of `waitForFrames` (kind `sampler`);
//   - a parameter default whose name matches /timeout|capMs|deadlineMs/i (kind `paramDefault`);
//   - a comparison of a `Date.now()` or `performance.now()` difference, directly or through a
//     variable set from one, with a cap (kind `deadline`);
//   - an `expect.poll` with no `timeout` at all (kind `poll`, value `default`).
// A Node socket timeout is not a test cap, and a sleep cannot fail, so neither is a site.
//
// VALUE: `literal` (a number, arithmetic of numbers, a `??` or `||` default that is one, or a
// name bound to one), `derived` (every leaf a `frameBudgetMs(count)` or `tickBudgetMs(count)`
// joined by `+`, optionally inside `addWaitBudget(sum, reason)`, or a `waitForFramesAtFloor`
// call; a count is a number, a name, a property read or arithmetic of those, and a second
// `frameBudgetMs` argument only a name or a property read), `default` (no timeout), and `other`
// (anything else, including a derived form plus milliseconds).
//
// REGION, what the wait reads, the strongest of CAPTURE > SAMPLER > INPUT > DRAWN > MODEL > DOM >
// IO > NONE found in the poll callback, the page function, the test body, the loop body or the
// helper body, following calls by name (same file first, then the support modules imported) and
// the in-page functions handed to the page by name (`page.evaluate(captureFrameInPage, args)`).
// A wait is FRAME-BOUND when its region is CAPTURE, SAMPLER, INPUT or DRAWN. A test limit is
// frame-bound only when its test reaches a capture or a pointer move outside a BUDGETING
// function (one whose body calls `addFrameBudget`).
//
// VERDICT, RED: a `literal` or `other` value on a frame-bound wait; a `default` on a CAPTURE
// region; a RAW CAPTURE (a capture primitive outside `captureClip` in `support/oracle.ts` and
// `requestScreen` in the composed walk); an UNKNOWN HOOK (a `__fabrico` member not in `HOOKS`).
//
// WHAT IT CANNOT SEE. A DOM wait whose text arrives through the chrome's frame-driven poll is
// classed DOM, not frame-bound. One wait class is told from another by the names it calls, so a
// capture reached through an alias or a dynamic call is missed. A single click, key press,
// button press or release is not counted as INPUT (each is one event the base limit carries). A
// cap passed positionally to a helper (`waitForCameraSettle(page, 10_000)`) is read only through
// the helper's own parameter default. A wait that reads a window property which an in-page
// animation-frame loop, started by an EARLIER `page.evaluate`, writes (`__flashSeen`, `__seam`,
// `__swapFrames`, `__newBoardSwapSeen`) is classed by the read alone, NONE, though the loop that
// fills it is frame-driven (plan 84-18 names the five such waits it left).
//
// Written for Node's type stripping as well as Vite: no enums, namespaces or parameter
// properties.

import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type SiteKind =
  | 'poll'
  | 'matcher'
  | 'waitFor'
  | 'pageWait'
  | 'scene'
  | 'option'
  | 'testLimit'
  | 'sampler'
  | 'paramDefault'
  | 'deadline';
export type ValueClass = 'literal' | 'derived' | 'default' | 'other';
export type Region = 'CAPTURE' | 'SAMPLER' | 'INPUT' | 'DRAWN' | 'MODEL' | 'DOM' | 'IO' | 'NONE';
export type HookClass = 'drawn' | 'model' | 'control';

export interface CapRow {
  path: string;
  line: number;
  kind: SiteKind;
  value: ValueClass;
  ms: number | null;
  region: Region;
  frameBound: boolean;
  verdict: 'ok' | 'RED';
  why: string;
  /** For a `testLimit`: the enclosing `test(` call, `<path>:<line>`. */
  test?: string;
}

export interface RawCapture {
  path: string;
  line: number;
}

export interface UnknownHook {
  name: string;
  path: string;
  line: number;
}

export interface CapSummary {
  files: number;
  sites: number;
  literal: number;
  derived: number;
  default: number;
  other: number;
  frameBound: number;
  red: number;
}

export interface ScanResult {
  rows: CapRow[];
  rawCaptures: RawCapture[];
  unknownHooks: UnknownHook[];
  summary: CapSummary;
  /** Files whose parse reported a syntax error. */
  unparsed: string[];
}

/**
 * Every `__fabrico` member the live suite reads, classed from its implementation in
 * `src/chrome/App.tsx` (`window.__fabrico = {...}`): `drawn` reads Pixi display state or the
 * render clock, `model` reads the decoded scene, stats or chrome state, `control` sets a seam.
 */
export const HOOKS: Readonly<Record<string, { cls: HookClass; why: string }>> = {
  scene: { cls: 'model', why: 'sceneSnapshot(handle.sceneState): the decoded scene' },
  stats: { cls: 'model', why: 'packetsApplied and decodeErrors: the packet counters' },
  selectedNode: { cls: 'model', why: "selectedNodeRef: the chrome's selection" },
  selectedBelt: { cls: 'model', why: "selectedBeltRef: the chrome's belt selection" },
  webhookUrl: { cls: 'model', why: "devWsInvoke('webhook_url'): the host's endpoint, over the dev bridge" },
  frame: { cls: 'drawn', why: 'handle.frame(): the quantized render clock, advanced in the Pixi ticker' },
  tickerTime: { cls: 'drawn', why: "handle.app.ticker.lastTime: when the Pixi ticker last finished a frame" },
  frameTime: { cls: 'drawn', why: 'frameProbe.avg(): the drawn frames average time' },
  camera: { cls: 'drawn', why: "handle.camera x and y and cam.worldScale(): the root Container's pan and zoom" },
  alertRingsActive: { cls: 'drawn', why: "handle.overlay.alertRingsActive(): the overlay's ring Graphics" },
  alertRingInstructions: { cls: 'drawn', why: "handle.overlay.alertRingInstructions(): the ring Graphics' instructions" },
  alertRingCentres: { cls: 'drawn', why: "handle.overlay.alertRingCentres(): the ring Graphics' centres" },
  targetRingsPlotted: { cls: 'drawn', why: 'handle.overlay.targetRingsPlotted(): the target ring Graphics' },
  rejectFlashInstructions: { cls: 'drawn', why: "handle.overlay.rejectFlashInstructions(): the refusal flash Graphics" },
  rejectFlashCell: { cls: 'drawn', why: "handle.overlay.rejectFlashCell(): the refusal flash Graphics' plotted box, as a cell" },
  rejectFlashSerial: { cls: 'drawn', why: 'handle.overlay.rejectFlashSerial(): how many refusal flashes were shown, read beside the plotted cell' },
  pendingInstructions: { cls: 'drawn', why: "handle.overlay.pendingInstructions(): the pending shimmer Graphics" },
  backedUpMarksPainted: { cls: 'drawn', why: 'handle.machines.loadGaugesPainted(): the gauge Graphics painted' },
  backedUpMarkPaintedOn: { cls: 'drawn', why: "handle.machines.loadGaugePaintedOn(id): one machine's gauge Graphics" },
  loadGaugeFormOn: { cls: 'drawn', why: "handle.machines.loadGaugeFormOn(id): the gauge Graphics' form" },
  portNubInstructionsOn: { cls: 'drawn', why: "handle.machines.portNubInstructionsOn(id): the nub Graphics' instructions" },
  labelBoxOn: { cls: 'drawn', why: 'handle.machines.labelBoxOn(id): the label box Graphics' },
  drawnNodes: { cls: 'drawn', why: 'handle.machines.drawnNodes(): the machine layer as drawn' },
  glyphSubjectOn: { cls: 'drawn', why: "handle.machines.glyphSubjectOn(id): the glyph a machine's sprite shows" },
  glyphBoxOn: { cls: 'drawn', why: "handle.machines.glyphBoxOn(id): the glyph Graphics' position and scaled box, and the body's footprint" },
  itemDots: { cls: 'drawn', why: 'handle.items.plottedDots(): the item layer as plotted' },
  itemDotsFrame: { cls: 'drawn', why: 'handle.items.plottedDotsFrame(): the item layer and the tick it was plotted from' },
  labelResizePreview: { cls: 'drawn', why: "handle.overlay.labelResizePreview(): the overlay's resize preview" },
  beltEndInstructionsOn: { cls: 'drawn', why: "handle.belts.endInstructionsOn(id): the belt end Graphics' instructions" },
  beltCollarCentresOn: { cls: 'drawn', why: "handle.belts.collarCentresOn(id): the junction collar centres on the belt end Graphics" },
  beltDrawnKindsOf: { cls: 'drawn', why: 'handle.belts drawn tile kinds: the belt layer as drawn' },
  beltPreviewInstructions: { cls: 'drawn', why: "handle.overlay.beltPreviewInstructions(): the preview Graphics" },
  beltPreviewKindAt: { cls: 'drawn', why: "handle.overlay.beltPreviewKindAt(x, y): the preview's tile kind as drawn" },
  beltTreadRotationAt: { cls: 'drawn', why: "handle.belts.treadRotationAt(x, y): the rotation of the belt tile object drawn at a cell" },
  beltPreviewPlotted: { cls: 'drawn', why: "handle.overlay.beltPreviewPlotted(): the drag preview Graphics' stroke colour" },
  ghostPlotted: { cls: 'drawn', why: "handle.overlay.ghostPlotted(): the ghost Graphics' body and fill colour" },
  wirePreviewPolylines: { cls: 'drawn', why: "handle.overlay.wirePreviewPolylines(): the wire preview Graphics" },
  rerouteMarkStrokes: { cls: 'drawn', why: "handle.wires.rerouteMarkStrokes(): the reroute mark's strokes" },
  cablePolylines: { cls: 'drawn', why: "handle.wires.cablePolylines(): the cable Graphics' polylines" },
  pinClock: { cls: 'control', why: 'handle.pinClock(n): freezes or frees the render clock' },
  setItemInterpolation: { cls: 'control', why: 'handle.setItemInterpolation(on): switches item interpolation' },
  setItemLayerVisible: { cls: 'control', why: 'handle.setItemLayerVisible(on): shows or hides the item layer' },
  requestQuit: { cls: 'control', why: 'the dirty-only quit decision, opens the guard' },
  editsAwaitingVerdict: { cls: 'model', why: 'editGesturesRef.size: the edit gestures sent and not yet answered' },
  hasUnsavedWork: { cls: 'model', why: "dirtyRef or queuedEditsRef: the guards' predicate, chrome state" },
  simulateStreamDrop: { cls: 'control', why: 'flips the dev stream-drop simulator' },
  controlsSent: { cls: 'model', why: 'sendCountsRef.controls: the controls the page handed to the transport' },
  inputsSent: { cls: 'model', why: 'sendCountsRef.inputs: the gestures the page handed to the transport' },
};

const REGION_ORDER: readonly Region[] = ['CAPTURE', 'SAMPLER', 'INPUT', 'DRAWN', 'MODEL', 'DOM', 'IO', 'NONE'];
const FRAME_BOUND: ReadonlySet<Region> = new Set<Region>(['CAPTURE', 'SAMPLER', 'INPUT', 'DRAWN']);

function stronger(a: Region, b: Region): Region {
  return REGION_ORDER.indexOf(a) <= REGION_ORDER.indexOf(b) ? a : b;
}

/** Calls the scanner treats as reading the model (besides a `model` hook). */
const MODEL_CALLS = new Set(['readScene', 'pollScene', 'readStats', 'readTickRecorder', 'startTickRecorder', 'stopTickRecorder']);
/** Calls the scanner treats as a frame sampler. */
const SAMPLER_CALLS = new Set(['requestAnimationFrame', 'waitForFrames', 'waitForFramesAtFloor', 'startFrameSampler']);
/** Playwright and DOM reads the scanner treats as DOM. */
const DOM_CALLS = new Set([
  'getByRole',
  'getByText',
  'getByTitle',
  'getByLabel',
  'getByTestId',
  'getByPlaceholder',
  'locator',
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'isVisible',
  'isHidden',
  'isChecked',
  'isEnabled',
  'isDisabled',
  'getAttribute',
  'boundingBox',
  'elementFromPoint',
  'querySelector',
  'querySelectorAll',
  'getComputedStyle',
]);
/** Files, network, save and load. */
const IO_CALLS = new Set([
  'readFileSync',
  'writeFileSync',
  'existsSync',
  'statSync',
  'readFile',
  'writeFile',
  'fetch',
  'setInputFiles',
  'waitForEvent',
  'waitForResponse',
  'waitForRequest',
  'goto',
  'reload',
]);
/** Receivers whose members are never followed as functions of the spec. */
const GLOBAL_RECEIVERS = new Set([
  'Promise',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Number',
  'String',
  'Date',
  'console',
  'expect',
  'test',
  'performance',
  'window',
  'document',
  'Buffer',
  'Set',
  'Map',
]);
/** The capture primitives' sanctioned homes. */
const CAPTURE_HOMES: readonly { file: RegExp; fn: string }[] = [
  { file: /^e2e-live\/support\/oracle\.ts$/, fn: 'captureClip' },
  { file: /^e2e-live\/77-one-board-all-five\.live\.spec\.ts$/, fn: 'requestScreen' },
];
const TIMEOUT_PARAM = /timeout|capMs|deadlineMs/i;

/** Options for the mutation proofs (never set by the gate or the lister). */
export interface ScanOptions {
  hooks?: Readonly<Record<string, { cls: HookClass; why: string }>>;
}

interface FnInfo {
  file: string;
  name: string;
  node: ts.Node;
  body: ts.Node | undefined;
  method: boolean;
}

interface FileInfo {
  path: string;
  sf: ts.SourceFile;
  /** Functions declared anywhere in the file, by name (the first wins). */
  fns: Map<string, FnInfo>;
  /** Object-literal methods, by name. */
  methods: Map<string, FnInfo>;
  /** Local import name -> [module path, exported name]. */
  imports: Map<string, [string, string]>;
  /** Top-level and nested `const` bindings, by name (the first wins). */
  consts: Map<string, ts.Expression>;
  /** Names bound to an expression ending in `.__fabrico`. */
  hookAliases: Set<string>;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  for (;;) {
    if (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isSatisfiesExpression(x)) {
      x = x.expression;
    } else if (ts.isTypeAssertionExpression(x)) {
      x = x.expression;
    } else {
      return x;
    }
  }
}

function calleeName(call: ts.CallExpression): string | null {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function receiverText(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  const c = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(c)) return unwrap(c.expression).getText(sf);
  return null;
}

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = from.split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let p = parts.join('/');
  if (!p.endsWith('.ts')) p += '.ts';
  return p;
}

function endsInFabrico(e: ts.Expression): boolean {
  const x = unwrap(e);
  return ts.isPropertyAccessExpression(x) && x.name.text === '__fabrico';
}

function indexFile(path: string, text: string): FileInfo {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const info: FileInfo = { path, sf, fns: new Map(), methods: new Map(), imports: new Map(), consts: new Map(), hookAliases: new Set() };
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && !info.fns.has(n.name.text)) {
      info.fns.set(n.name.text, { file: path, name: n.name.text, node: n, body: n.body, method: false });
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && !info.fns.has(n.name.text)) {
        info.fns.set(n.name.text, { file: path, name: n.name.text, node: init, body: init.body, method: false });
      }
      if (!info.consts.has(n.name.text)) info.consts.set(n.name.text, n.initializer);
      if (endsInFabrico(n.initializer)) info.hookAliases.add(n.name.text);
    } else if (ts.isMethodDeclaration(n) && n.body && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const name = n.name.text;
      if (!info.methods.has(name)) info.methods.set(name, { file: path, name, node: n, body: n.body, method: true });
    } else if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
      const init = unwrap(n.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && !info.methods.has(n.name.text)) {
        info.methods.set(n.name.text, { file: path, name: n.name.text, node: init, body: init.body, method: true });
      }
    } else if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = resolveModule(path, n.moduleSpecifier.text);
      const named = n.importClause?.namedBindings;
      if (mod && named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          info.imports.set(el.name.text, [mod, (el.propertyName ?? el.name).text]);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return info;
}

/** Every `.ts` file under `frontend/e2e-live` plus `frontend/e2e/support/frameSampler.ts`, keyed by path from `frontend/`. */
export function readLiveSources(frontendDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.ts')) out[relative(frontendDir, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(join(frontendDir, 'e2e-live'));
  const fs = join(frontendDir, 'e2e', 'support', 'frameSampler.ts');
  out['e2e/support/frameSampler.ts'] = readFileSync(fs, 'utf8');
  return out;
}

export function scanLiveWaitCaps(sources: Readonly<Record<string, string>>, options: ScanOptions = {}): ScanResult {
  const hooks = options.hooks ?? HOOKS;
  const files = new Map<string, FileInfo>();
  const unparsed: string[] = [];
  for (const path of Object.keys(sources).sort()) {
    const info = indexFile(path, sources[path]);
    const diags = (info.sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
    if (diags.length > 0) unparsed.push(path);
    files.set(path, info);
  }

  // ---- function resolution --------------------------------------------------------------
  const resolveFn = (file: FileInfo, name: string): FnInfo | null => {
    const local = file.fns.get(name);
    if (local) return local;
    const imp = file.imports.get(name);
    if (imp) {
      const target = files.get(imp[0]);
      if (target) return target.fns.get(imp[1]) ?? null;
    }
    return null;
  };
  const resolveCall = (file: FileInfo, call: ts.CallExpression): FnInfo | null => {
    const c = unwrap(call.expression);
    if (ts.isIdentifier(c)) return resolveFn(file, c.text);
    if (ts.isPropertyAccessExpression(c)) {
      const recv = unwrap(c.expression);
      if (ts.isIdentifier(recv) && GLOBAL_RECEIVERS.has(recv.text)) return null;
      return file.methods.get(c.name.text) ?? null;
    }
    return null;
  };

  // ---- constant values -----------------------------------------------------------------
  const resolveConst = (file: FileInfo, name: string, depth = 0): [FileInfo, ts.Expression] | null => {
    if (depth > 8) return null;
    const local = file.consts.get(name);
    if (local) return [file, local];
    const imp = file.imports.get(name);
    if (imp) {
      const target = files.get(imp[0]);
      if (target) {
        const e = target.consts.get(imp[1]);
        if (e) return [target, e];
      }
    }
    return null;
  };

  /** The number a literal expression evaluates to, or null when it is not one. */
  const literalValue = (file: FileInfo, e: ts.Expression, depth = 0): number | null => {
    if (depth > 8) return null;
    const x = unwrap(e);
    if (ts.isNumericLiteral(x)) return Number(x.text.replace(/_/g, ''));
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken) {
      const v = literalValue(file, x.operand, depth + 1);
      return v === null ? null : -v;
    }
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        return literalValue(file, x.right, depth + 1);
      }
      const a = literalValue(file, x.left, depth + 1);
      const b = literalValue(file, x.right, depth + 1);
      if (a === null || b === null) return null;
      if (op === ts.SyntaxKind.PlusToken) return a + b;
      if (op === ts.SyntaxKind.MinusToken) return a - b;
      if (op === ts.SyntaxKind.AsteriskToken) return a * b;
      if (op === ts.SyntaxKind.SlashToken) return a / b;
      return null;
    }
    if (ts.isIdentifier(x)) {
      const bound = resolveConst(file, x.text);
      return bound ? literalValue(bound[0], bound[1], depth + 1) : null;
    }
    return null;
  };

  const isCount = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isNumericLiteral(x) || ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) return true;
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      const arith = [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken];
      return arith.includes(op) && isCount(x.left) && isCount(x.right);
    }
    if (ts.isCallExpression(x)) {
      const n = calleeName(x);
      return (n === 'max' || n === 'min' || n === 'ceil') && x.arguments.every(isCount);
    }
    return false;
  };

  const isDerivedSum = (file: FileInfo, e: ts.Expression, depth = 0): boolean => {
    const x = unwrap(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return isDerivedSum(file, x.left, depth) && isDerivedSum(file, x.right, depth);
    }
    if (ts.isCallExpression(x) && ts.isIdentifier(unwrap(x.expression))) {
      const n = (unwrap(x.expression) as ts.Identifier).text;
      if (n === 'frameBudgetMs') {
        if (x.arguments.length < 1 || x.arguments.length > 2 || !isCount(x.arguments[0])) return false;
        if (x.arguments.length === 2) {
          const m = unwrap(x.arguments[1]);
          return ts.isIdentifier(m) || ts.isPropertyAccessExpression(m);
        }
        return true;
      }
      if (n === 'tickBudgetMs') return x.arguments.length === 1 && isCount(x.arguments[0]);
    }
    if (ts.isIdentifier(x) && depth < 8) {
      const bound = resolveConst(file, x.text);
      return bound ? isDerivedSum(bound[0], bound[1], depth + 1) : false;
    }
    return false;
  };

  const isDerived = (file: FileInfo, e: ts.Expression, depth = 0): boolean => {
    const x = unwrap(e);
    if (ts.isCallExpression(x) && ts.isIdentifier(unwrap(x.expression))) {
      const n = (unwrap(x.expression) as ts.Identifier).text;
      if (n === 'addWaitBudget') return x.arguments.length === 2 && isDerivedSum(file, x.arguments[0]);
      if (n === 'waitForFramesAtFloor') return true;
    }
    if (ts.isIdentifier(x) && depth < 8) {
      const bound = resolveConst(file, x.text);
      if (bound && isDerived(bound[0], bound[1], depth + 1)) return true;
    }
    return isDerivedSum(file, x);
  };

  const classify = (file: FileInfo, e: ts.Expression | undefined): [ValueClass, number | null] => {
    if (e === undefined) return ['default', null];
    const lit = literalValue(file, e);
    if (lit !== null) return ['literal', lit];
    if (isDerived(file, e)) return ['derived', null];
    return ['other', null];
  };

  // ---- hooks ----------------------------------------------------------------------------
  /** The `__fabrico` member a property access reads, or null. */
  const hookOf = (file: FileInfo, n: ts.Node): string | null => {
    if (!ts.isPropertyAccessExpression(n)) return null;
    const recv = unwrap(n.expression);
    if (endsInFabrico(recv)) return n.name.text;
    if (ts.isIdentifier(recv) && file.hookAliases.has(recv.text)) return n.name.text;
    return null;
  };

  // ---- primitives and regions -------------------------------------------------------------
  const isCapturePrimitive = (file: FileInfo, call: ts.CallExpression): boolean => {
    const name = calleeName(call);
    const c = unwrap(call.expression);
    if (name === 'screenshot' && ts.isPropertyAccessExpression(c)) return true;
    if (name === 'send' && call.arguments.length > 0) {
      const a = unwrap(call.arguments[0]);
      if (ts.isStringLiteral(a) && a.text === 'Page.captureScreenshot') return true;
    }
    void file;
    return false;
  };
  const isMouseInput = (file: FileInfo, call: ts.CallExpression): boolean => {
    const c = unwrap(call.expression);
    if (!ts.isPropertyAccessExpression(c)) return false;
    if (c.name.text !== 'move' && c.name.text !== 'wheel') return false;
    const recv = unwrap(c.expression);
    return /(^|\.)mouse$/.test(recv.getText(file.sf));
  };

  /** The region of the primitives written in `node` itself (nested functions included). */
  const directRegion = (file: FileInfo, node: ts.Node): Region => {
    let r: Region = 'NONE';
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (isCapturePrimitive(file, n)) r = stronger(r, 'CAPTURE');
        else if (name !== null && SAMPLER_CALLS.has(name)) r = stronger(r, 'SAMPLER');
        else if (isMouseInput(file, n)) r = stronger(r, 'INPUT');
        else if (name !== null && MODEL_CALLS.has(name)) r = stronger(r, 'MODEL');
        else if (name !== null && DOM_CALLS.has(name)) r = stronger(r, 'DOM');
        else if (name !== null && IO_CALLS.has(name)) r = stronger(r, 'IO');
      }
      if (ts.isIdentifier(n) && n.text === 'document' && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        r = stronger(r, 'DOM');
      }
      const h = hookOf(file, n);
      if (h !== null) {
        const cls = hooks[h]?.cls;
        if (cls === 'drawn') r = stronger(r, 'DRAWN');
        else if (cls === 'model') r = stronger(r, 'MODEL');
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return r;
  };

  const calls = (node: ts.Node): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  /** An in-page function handed to the page by name (`page.evaluate(fnName, arg)`): its body
   *  runs in the page as part of the wait, exactly as an inline in-page function does. */
  const IN_PAGE_CALLS = new Set(['evaluate', 'evaluateHandle', 'waitForFunction']);
  const inPageByName = (file: FileInfo, call: ts.CallExpression): FnInfo | null => {
    const name = calleeName(call);
    if (name === null || !IN_PAGE_CALLS.has(name) || call.arguments.length === 0) return null;
    const f = unwrap(call.arguments[0]);
    return ts.isIdentifier(f) ? resolveFn(file, f.text) : null;
  };

  const regionMemo = new Map<FnInfo, Region>();
  /** The region of `node`, following the calls it makes by name, transitively, and the in-page
   *  functions it hands to the page by name. */
  const regionOf = (file: FileInfo, node: ts.Node, seen: Set<FnInfo> = new Set()): Region => {
    let r = directRegion(file, node);
    for (const call of calls(node)) {
      const fn = resolveCall(file, call) ?? inPageByName(file, call);
      if (fn === null || fn.body === undefined || seen.has(fn)) continue;
      let fr = regionMemo.get(fn);
      if (fr === undefined) {
        seen.add(fn);
        fr = regionOf(files.get(fn.file)!, fn.body, seen);
        seen.delete(fn);
        regionMemo.set(fn, fr);
      }
      r = stronger(r, fr);
    }
    return r;
  };

  const budgeting = (fn: FnInfo): boolean => calls(fn.body!).some((c) => calleeName(c) === 'addFrameBudget');

  /** Whether `node` reaches a capture or a pointer move outside a budgeting function. */
  const unbudgetedTravel = (file: FileInfo, node: ts.Node, seen: Set<FnInfo> = new Set()): boolean => {
    for (const call of calls(node)) {
      if (isCapturePrimitive(file, call) || isMouseInput(file, call)) return true;
      const fn = resolveCall(file, call);
      if (fn === null || fn.body === undefined || seen.has(fn) || budgeting(fn)) continue;
      seen.add(fn);
      if (unbudgetedTravel(files.get(fn.file)!, fn.body, seen)) return true;
    }
    return false;
  };

  // ---- sites ----------------------------------------------------------------------------
  const rows: CapRow[] = [];
  const rawCaptures: RawCapture[] = [];
  const unknownHooks: UnknownHook[] = [];

  const enclosingFunctionName = (n: ts.Node): string | null => {
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) {
        return p.parent.name.text;
      }
      p = p.parent;
    }
    return null;
  };

  const enclosingTest = (file: FileInfo, n: ts.Node): ts.CallExpression | null => {
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isCallExpression(p)) {
        const c = unwrap(p.expression);
        const isTest =
          (ts.isIdentifier(c) && c.text === 'test') ||
          (ts.isPropertyAccessExpression(c) && ts.isIdentifier(unwrap(c.expression)) && (unwrap(c.expression) as ts.Identifier).text === 'test' && ['only', 'skip', 'fixme', 'fail'].includes(c.name.text));
        if (isTest && p.arguments.length >= 2) return p;
      }
      p = p.parent;
    }
    void file;
    return null;
  };

  const enclosingLoopOrFn = (n: ts.Node): ts.Node => {
    let p: ts.Node | undefined = n.parent;
    while (p) {
      if (ts.isWhileStatement(p) || ts.isDoStatement(p) || ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p)) return p;
      if (ts.isFunctionLike(p)) return p;
      p = p.parent;
    }
    return n;
  };

  const push = (file: FileInfo, node: ts.Node, kind: SiteKind, value: [ValueClass, number | null], region: Region, frameBound: boolean, test?: string): void => {
    const [v, ms] = value;
    let red = false;
    let why = '';
    if ((v === 'literal' || v === 'other') && frameBound) {
      red = true;
      why = `a ${v} cap around a frame-bound ${region} wait (D-12: derive it from its frames)`;
    } else if (v === 'default' && region === 'CAPTURE') {
      red = true;
      why = 'a capture wait with no cap of its own (the default cap knows no frames)';
    } else if (v === 'derived') {
      why = 'derived from frames and ticks';
    } else if (kind === 'testLimit' && !frameBound) {
      why = "a test limit whose test's captures and pointer travel are each budgeted on it";
    } else if (!frameBound) {
      why =
        region === 'NONE'
          ? 'waits on nothing the scanner classes as frame-bound'
          : `a ${region} wait: D-12 covers frame-bound waits only (84-08 and 84-09 keep its cap)`;
    } else {
      why = `a ${v} value on a frame-bound wait`;
    }
    rows.push({ path: file.path, line: lineOf(file.sf, node), kind, value: v, ms, region, frameBound, verdict: red ? 'RED' : 'ok', why, test });
  };

  for (const file of files.values()) {
    if (!file.path.startsWith('e2e-live/')) continue;
    const sf = file.sf;
    const visit = (n: ts.Node): void => {
      // RAW CAPTURE
      if (ts.isCallExpression(n) && isCapturePrimitive(file, n)) {
        const home = enclosingFunctionName(n);
        const ok = CAPTURE_HOMES.some((h) => h.file.test(file.path) && h.fn === home);
        if (!ok) rawCaptures.push({ path: file.path, line: lineOf(sf, n) });
      }
      // UNKNOWN HOOK: accesses
      const h = hookOf(file, n);
      if (h !== null && !(h in hooks)) unknownHooks.push({ name: h, path: file.path, line: lineOf(sf, n) });
      // UNKNOWN HOOK: type literal members of a `__fabrico` property
      if ((ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === '__fabrico' && n.type && ts.isTypeLiteralNode(n.type)) {
        for (const m of n.type.members) {
          if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) && !(m.name.text in hooks)) {
            unknownHooks.push({ name: m.name.text, path: file.path, line: lineOf(sf, m) });
          }
        }
      }

      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        const c = unwrap(n.expression);
        // expect.poll
        const isPoll = name === 'poll' && ts.isPropertyAccessExpression(c) && /^expect(\.soft)?$/.test(unwrap(c.expression).getText(sf));
        // timeout options passed to this call
        const optArg = n.arguments.find((a) => ts.isObjectLiteralExpression(unwrap(a))) as ts.Expression | undefined;
        let timeoutProp: ts.PropertyAssignment | undefined;
        for (const a of n.arguments) {
          const o = unwrap(a);
          if (!ts.isObjectLiteralExpression(o)) continue;
          for (const p of o.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'timeout') timeoutProp = p;
            if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'timeout') timeoutProp = undefined;
          }
        }
        void optArg;
        if (isPoll) {
          const cb = n.arguments[0];
          const region = cb ? regionOf(file, cb) : 'NONE';
          if (timeoutProp) push(file, timeoutProp, 'poll', classify(file, timeoutProp.initializer), region, FRAME_BOUND.has(region));
          else push(file, n, 'poll', classify(file, undefined), region, FRAME_BOUND.has(region));
        } else if (timeoutProp && name !== null) {
          const recv = receiverText(n, sf);
          if (/^to[A-Z]/.test(name)) {
            push(file, timeoutProp, 'matcher', classify(file, timeoutProp.initializer), 'DOM', false);
          } else if (name === 'waitForFunction') {
            const fnArg = n.arguments[0];
            let region: Region = 'NONE';
            if (fnArg) {
              const f = unwrap(fnArg);
              if (ts.isIdentifier(f)) {
                const fn = resolveFn(file, f.text);
                region = fn?.body ? regionOf(files.get(fn.file)!, fn.body) : 'NONE';
              } else region = regionOf(file, f);
            }
            push(file, timeoutProp, 'pageWait', classify(file, timeoutProp.initializer), region, FRAME_BOUND.has(region));
          } else if (/^waitFor/.test(name)) {
            push(file, timeoutProp, 'waitFor', classify(file, timeoutProp.initializer), 'DOM', false);
          } else if (name === 'pollScene') {
            push(file, timeoutProp, 'scene', classify(file, timeoutProp.initializer), 'MODEL', false);
          } else if (!(recv !== null && /(^|\.)socket$/.test(recv))) {
            const fn = resolveCall(file, n);
            let region: Region;
            if (fn?.body) region = regionOf(files.get(fn.file)!, fn.body);
            else if (name !== null && IO_CALLS.has(name)) region = 'IO';
            else region = 'DOM';
            push(file, timeoutProp, 'option', classify(file, timeoutProp.initializer), region, FRAME_BOUND.has(region));
          }
        }
        // test limits
        if (name === 'setTimeout' && ts.isPropertyAccessExpression(c)) {
          const r = unwrap(c.expression).getText(sf).replace(/\s+/g, '');
          if (r === 'test' || r === 'test.info()' || r === 'testInfo') {
            const t = enclosingTest(file, n);
            const body = t ? t.arguments[t.arguments.length - 1] : undefined;
            const travel = body ? unbudgetedTravel(file, body) : false;
            const region = body ? regionOf(file, body) : 'NONE';
            push(file, n, 'testLimit', classify(file, n.arguments[0]), region, travel, t ? `${file.path}:${lineOf(sf, t)}` : `${file.path}:-`);
          }
        }
        // sampler caps: `waitForFrames(page, key, capMs = FRAME_CAP_MS)`, its third argument
        if (name === 'waitForFrames' && n.arguments.length >= 3) {
          push(file, n.arguments[2], 'sampler', classify(file, n.arguments[2]), 'SAMPLER', true);
        }
      }
      // parameter defaults named as a timeout
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.initializer && TIMEOUT_PARAM.test(n.name.text)) {
        const fn = n.parent;
        const body = (fn as ts.FunctionLikeDeclaration).body;
        const region = body ? regionOf(file, body) : 'NONE';
        push(file, n, 'paramDefault', classify(file, n.initializer), region, FRAME_BOUND.has(region));
      }
      // deadlines
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken].includes(n.operatorToken.kind)) {
        const cap = deadlineCap(file, n);
        if (cap !== null) {
          const scope = enclosingLoopOrFn(n);
          const region = regionOf(file, scope);
          push(file, n, 'deadline', capValue(file, cap, n), region, FRAME_BOUND.has(region));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  /** `Date.now()` or `performance.now()`. */
  function isNow(e: ts.Expression): boolean {
    const x = unwrap(e);
    if (!ts.isCallExpression(x) || x.arguments.length !== 0) return false;
    const c = unwrap(x.expression);
    return ts.isPropertyAccessExpression(c) && c.name.text === 'now' && /^(Date|performance)$/.test(unwrap(c.expression).getText());
  }
  /** `now() - x` (a difference with now). */
  function isNowDiff(file: FileInfo, e: ts.Expression): boolean {
    const x = unwrap(e);
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.MinusToken) return isNow(x.left) || isNow(x.right);
    if (ts.isIdentifier(x)) {
      const b = file.consts.get(x.text);
      return b !== undefined && isNowDiff(file, b);
    }
    return false;
  }
  /** `now() + cap` bound to a name: returns the cap. */
  function nowPlus(file: FileInfo, e: ts.Expression): ts.Expression | null {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) {
      const b = file.consts.get(x.text);
      if (b === undefined) return null;
      const y = unwrap(b);
      if (ts.isBinaryExpression(y) && y.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        if (isNow(y.left)) return y.right;
        if (isNow(y.right)) return y.left;
      }
    }
    return null;
  }
  /** The cap of a deadline comparison, or null when `n` is not one. */
  function deadlineCap(file: FileInfo, n: ts.BinaryExpression): ts.Expression | null {
    if (isNowDiff(file, n.left)) return n.right;
    if (isNowDiff(file, n.right)) return n.left;
    if (isNow(n.left)) return nowPlus(file, n.right);
    if (isNow(n.right)) return nowPlus(file, n.left);
    return null;
  }
  /** A deadline cap's value: a parameter takes its default's class. */
  function capValue(file: FileInfo, cap: ts.Expression, at: ts.Node): [ValueClass, number | null] {
    const x = unwrap(cap);
    if (ts.isIdentifier(x)) {
      let p: ts.Node | undefined = at.parent;
      while (p) {
        if (ts.isFunctionLike(p)) {
          const param = (p as ts.SignatureDeclaration).parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === x.text);
          if (param) return param.initializer ? classify(file, param.initializer) : ['other', null];
        }
        p = p.parent;
      }
    }
    return classify(file, cap);
  }

  rows.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  rawCaptures.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  const summary: CapSummary = {
    files: [...files.keys()].filter((p) => p.startsWith('e2e-live/')).length,
    sites: rows.length,
    literal: rows.filter((r) => r.value === 'literal').length,
    derived: rows.filter((r) => r.value === 'derived').length,
    default: rows.filter((r) => r.value === 'default').length,
    other: rows.filter((r) => r.value === 'other').length,
    frameBound: rows.filter((r) => r.frameBound).length,
    red: rows.filter((r) => r.verdict === 'RED').length + rawCaptures.length + unknownHooks.length,
  };
  return { rows, rawCaptures, unknownHooks, summary, unparsed };
}

/** One `CAP` row: `CAP <path>:<line> kind= value= ms= region= frameBound= verdict= why=[ test=]`. */
export function formatRow(row: CapRow): string {
  const base =
    `CAP ${row.path}:${row.line} kind=${row.kind} value=${row.value} ms=${row.ms === null ? '-' : Math.round(row.ms)} ` +
    `region=${row.region} frameBound=${row.frameBound ? 1 : 0} verdict=${row.verdict} why=${row.why}`;
  return row.test === undefined ? base : `${base} test=${row.test}`;
}

/** The summary line. */
export function formatSummary(s: CapSummary): string {
  return `LIVE_WAIT_CAPS files=${s.files} sites=${s.sites} literal=${s.literal} derived=${s.derived} default=${s.default} other=${s.other} frameBound=${s.frameBound} red=${s.red}`;
}
