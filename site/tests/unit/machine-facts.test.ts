// The fact table a machine page's <MachineFacts kind={N} /> renders, checked against the real
// src/generated/facts.json, plus a hand-built entry for a port value the component has no word for.
// Run with `npm run test:unit` in site/ (plain Node, which strips the types).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { machineView, type FactsFile, type MachineView } from '../../src/lib/facts.ts';

const FACTS_PATH = path.resolve(import.meta.dirname, '../../src/generated/facts.json');
const FACTS = JSON.parse(fs.readFileSync(FACTS_PATH, 'utf8')) as FactsFile;
const PAGE = 'site/src/content/docs/reference/machines/router.mdx';

/** The view for a kind, or a failed assertion naming what it threw. */
function view(kind: number, facts: FactsFile = FACTS): MachineView {
  return machineView(kind, PAGE, facts);
}

/** The message machineView throws, or a failed assertion when it returns. */
function thrown(kind: number, facts: FactsFile = FACTS): string {
  try {
    const found = machineView(kind, PAGE, facts);
    assert.fail(`machineView(${kind}) returned the ${found.name} table instead of throwing`);
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    assert.ok(err instanceof Error);
    return err.message;
  }
}

test('facts.json holds the twelve machine kinds this file checks', () => {
  assert.ok((FACTS.machines ?? []).length >= 12, `${FACTS_PATH} holds ${(FACTS.machines ?? []).length} machines, expected at least 12`);
});

test('Router: five ports in data order, two config fields, 2 cells wide and 3 tall', () => {
  const router = view(5);
  assert.equal(router.name, 'Router');
  assert.equal(router.nameFact, 'machine.Router.name');
  assert.equal(router.codeName, 'Router');
  assert.equal(router.kindFact, 'machine.Router.kind');
  assert.equal(router.size, '2 cells wide, 3 cells tall');
  assert.deepEqual(router.configFacts, ['config.Router.routes', 'config.Router.default']);
  assert.deepEqual(router.ports, [
    { role: 'In', takes: 'Belt', side: 'West', cell: '0, 1' },
    { role: 'Out', takes: 'Belt', side: 'East', cell: '1, 1' },
    { role: 'Out', takes: 'Belt', side: 'East', cell: '1, 2' },
    { role: 'Out', takes: 'Belt', side: 'East', cell: '1, 0' },
    { role: 'Fault', takes: 'Belt', side: 'South', cell: '0, 2' },
  ]);
});

test('Source: one port and the singular cell in both directions', () => {
  const source = view(0);
  assert.equal(source.size, '1 cell wide, 1 cell tall');
  assert.equal(source.ports.length, 1);
  assert.deepEqual(source.ports[0], { role: 'Out', takes: 'Belt', side: 'East', cell: '0, 0' });
  assert.deepEqual(source.configFacts, ['config.Source.trigger']);
});

test('Wire: no ports, no footprint, no config fields and no app-name fact', () => {
  const wire = view(8);
  assert.equal(wire.name, 'Wire');
  assert.equal(wire.nameFact, null);
  assert.equal(wire.size, 'None. It takes no grid cells.');
  assert.deepEqual(wire.configFacts, []);
  assert.deepEqual(wire.ports, []);
});

test('Label: four config fields in data order and no ports', () => {
  const label = view(11);
  assert.deepEqual(label.configFacts, ['config.Label.text', 'config.Label.colour', 'config.Label.w', 'config.Label.h']);
  assert.deepEqual(label.ports, []);
  assert.equal(label.size, '4 cells wide, 1 cell tall');
});

test('Route and HTTP Handler show the app name, and the code name stays the code name', () => {
  const route = view(9);
  assert.equal(route.name, 'Route');
  assert.equal(route.codeName, 'Endpoint');
  assert.equal(route.ports[0]?.takes, 'Wire');
  const handler = view(10);
  assert.equal(handler.name, 'HTTP Handler');
  assert.equal(handler.codeName, 'Handler');
  assert.deepEqual(handler.configFacts, ['config.Factory.source']);
});

test('a port side with no word throws the line naming the field and the value', () => {
  const machines = structuredClone(FACTS.machines ?? []);
  const router = machines.find((m) => m.kind === 5);
  assert.ok(router !== undefined);
  router.ports[1] = { ...router.ports[1], side: 'Q' };
  assert.equal(
    thrown(5, { ...FACTS, machines }),
    '[MachineFacts] machine kind 5 has a port with side "Q", and site/src/lib/facts.ts has no word for it. Add one there.',
  );
});

test('a port role or medium with no word throws the same line for that field', () => {
  const machines = structuredClone(FACTS.machines ?? []);
  const source = machines.find((m) => m.kind === 0);
  assert.ok(source !== undefined);
  source.ports[0] = { ...source.ports[0], role: 'Sideways' };
  assert.match(thrown(0, { ...FACTS, machines }), /port with role "Sideways"/);
  source.ports[0] = { ...source.ports[0], role: 'Out', medium: 'Optical' };
  assert.match(thrown(0, { ...FACTS, machines }), /port with medium "Optical"/);
});

test('a kind facts.json does not hold throws the line listing the known kinds', () => {
  const known = (FACTS.machines ?? []).map((m) => m.kind).join(', ');
  assert.equal(
    thrown(99),
    `[MachineFacts] ${PAGE} asks for machine kind 99, and site/src/generated/facts.json has no machine with that kind. Known kinds: ${known}.`,
  );
});
