// triggerRead.ts - the one place the tutorial asks the host anything. The model carries no machine
// config, so `machine_config` is the one read, the same query the inspector makes: a bound machine's
// applied config. A bridge here can send any command, so it goes to `loadConfig` and no further, and
// only the answer leaves this file. tutorialPurity.source.test.ts holds this file to that.

import type { MachineConfig } from '../../protocol/decode';
import { devWsInvoke } from '../../transport/devWsInvoke';
import { transportKind } from '../../transport/transport';
import type { ChromeFacts } from '../../tutorial/types';
import { loadConfig, tauriInvoke } from '../ConfigPanel';

/** The config the host has applied on `node`, or null if it has none. Rejects when the query fails. */
export async function readAppliedConfig(node: number): Promise<MachineConfig | null> {
  return loadConfig(node, transportKind() === 'dev' ? devWsInvoke : tauriInvoke);
}

/** The trigger the host has applied on `node`, or null if it isn't a Source. Rejects when the query fails. */
export async function readAppliedTrigger(node: number): Promise<ChromeFacts['appliedTrigger']> {
  const config = await readAppliedConfig(node);
  return config?.kind === 'Source' ? { node, kind: config.trigger.kind } : null;
}
