import { liveCoverageOptions } from './liveTest';

// liveCoverageTeardown.ts - writes the live suite coverage report at the end of a run (phase 112,
// D-07). Both live configs name it as `globalTeardown` only when FABRICO_LIVE_COVERAGE is set, and
// it returns at once without the variable. The reading is local: CI never sets the variable.
export default async function liveCoverageTeardown(): Promise<void> {
  const label = process.env.FABRICO_LIVE_COVERAGE;
  if (!label) return;
  const { MCR } = await import('monocart-coverage-reports');
  await MCR(liveCoverageOptions(label)).generate();
}
