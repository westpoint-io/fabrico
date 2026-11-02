import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { type FenceCall, type FenceProbeResult, MAP_RECURSION, RECURSION, RUNAWAY, fenceProbe } from './fence-probe.ts';

// A Factory that recurses forever has to fault like any other Factory in the wasm build, and the
// instance has to live on. QuickJS's stack limit counts wasm's linear-memory stack, and the same
// wasm frames also spend the JavaScript engine's own stack, which QuickJS can't see. If that one
// runs out first, the call throws and the whole instance is gone. The engine's stack is smallest in
// a Worker, so this runs the probe in the test's own Node process, on Chromium's main thread and in
// a Chromium Worker, for plain recursion and for recursion through Array.map.
//
// Run it through scripts/check-player-browser.sh, which sets FABRICO_CORPUS_WASM.

const SHAPE_NAMES: Record<number, string> = {
  [RECURSION]: 'plain recursion',
  [MAP_RECURSION]: 'recursion through Array.map',
};

function corpusWasm(): Buffer {
  const path = process.env.FABRICO_CORPUS_WASM;
  if (path === undefined) {
    throw new Error('FABRICO_CORPUS_WASM is unset. Build the harness and run this through scripts/check-player-browser.sh.');
  }
  return readFileSync(path);
}

function describeCall(call: FenceCall): string {
  return `${call.kind} (status ${call.status}): ${call.text.split('\n')[0]}`;
}

function expectCleanFault(call: FenceCall, what: string): void {
  expect(call.kind, `${what} should be a Factory fault, and got ${describeCall(call)}`).toBe('fault');
  expect(call.status, `${what}: ${describeCall(call)}`).toBe(1);
  expect(call.text, `${what}: ${describeCall(call)}`).toContain('Maximum call stack size exceeded');
}

function expectRan(call: FenceCall, what: string): void {
  expect(call.kind, `${what} should run, and got ${describeCall(call)}`).toBe('ran');
}

/** Logs the numbers, then asserts the behaviour on both shapes. */
function assertProbe(place: string, result: FenceProbeResult): void {
  for (const shape of result.shapes) {
    const name = SHAPE_NAMES[shape.shape] ?? `shape ${shape.shape}`;
    console.log(
      `FENCE_PROBE ${place} ${name}: first fault at depth ${shape.firstFault} (${shape.atFirstFault.kind}) ` +
        `under the ${result.defaultStack}-byte default, linear-memory stack ${result.shadowStack} bytes. ` +
        `Depth ${RUNAWAY} under the old 524288-byte default: ${describeCall(shape.runawayAtOldLimit)}`,
    );
  }
  expect(result.shadowStack, 'the linear-memory stack should be larger than the stack limit').toBeGreaterThan(
    result.defaultStack,
  );
  expect(result.shapes.map((shape) => shape.shape)).toEqual([RECURSION, MAP_RECURSION]);
  for (const shape of result.shapes) {
    const name = `${place}, ${SHAPE_NAMES[shape.shape]}`;
    expectCleanFault(shape.runaway, `${name}, depth ${RUNAWAY}`);
    expectCleanFault(shape.atFirstFault, `${name}, depth ${shape.firstFault}, the first that didn't run`);
    expectRan(shape.belowAtDefault, `${name}, depth ${shape.firstFault - 1} at the default limit`);
    // The depth that just ran at the default has to fault at a quarter of it, which only the limit
    // passed to build reaching the engine can do.
    expectCleanFault(
      shape.belowAtQuarter,
      `${name}, depth ${shape.firstFault - 1} at a quarter of the default limit`,
    );
    expectRan(shape.shallow, `${name}, depth ${shape.shallowDepth}`);
  }
}

async function blankPage(page: Page): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('about:blank');
  expect(pageErrors).toEqual([]);
}

test('a runaway recursion faults cleanly in Node', async () => {
  const result = await fenceProbe(new Uint8Array(corpusWasm()));
  assertProbe('node', result);
});

test("a runaway recursion faults cleanly on Chromium's main thread", async ({ page }) => {
  await blankPage(page);
  const result = await page.evaluate(
    async ({ source, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const probe = new Function(`return (${source})`)() as (bytes: Uint8Array<ArrayBuffer>) => Promise<FenceProbeResult>;
      return probe(bytes);
    },
    { source: fenceProbe.toString(), base64: corpusWasm().toString('base64') },
  );
  assertProbe('chromium-main', result);
});

test('a runaway recursion faults cleanly in a Chromium Worker', async ({ page }) => {
  await blankPage(page);
  const result = await page.evaluate(
    async ({ source, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const script = `const fenceProbe = ${source};
        onmessage = (event) => {
          fenceProbe(event.data).then(
            (result) => postMessage({ result }),
            (error) => postMessage({ error: String(error) }),
          );
        };`;
      const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const answer = await new Promise<{ result?: FenceProbeResult; error?: string }>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => resolve({ error: event.message });
        worker.postMessage(bytes);
      });
      worker.terminate();
      URL.revokeObjectURL(url);
      if (answer.result === undefined) throw new Error(`the Worker failed: ${answer.error}`);
      return answer.result;
    },
    { source: fenceProbe.toString(), base64: corpusWasm().toString('base64') },
  );
  assertProbe('chromium-worker', result);
});
