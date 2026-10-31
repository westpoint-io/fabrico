// triggerRead.ts - the one place the tutorial asks the host anything. The model has no Source trigger,
// so `machine_config` is the one read, the same query the inspector makes. A bridge here can send any
// command, so it goes to `loadConfig` and no further, and only the answer leaves this file.
// tutorialPurity.source.test.ts holds this file to that.

import { devWsInvoke } from '../../transport/devWsInvoke';
import { transportKind } from '../../transport/transport';
import type { ChromeFacts } from '../../tutorial/types';
import { loadConfig, tauriInvoke } from '../ConfigPanel';

/** The trigger the host has applied on `node`, or null if it isn't a Source. Rejects when the query fails. */
export async function readAppliedTrigger(node: number): Promise<ChromeFacts['appliedTrigger']> {
  const config = await loadConfig(node, transportKind() === 'dev' ? devWsInvoke : tauriInvoke);
  return config?.kind === 'Source' ? { node, kind: config.trigger.kind } : null;
}
