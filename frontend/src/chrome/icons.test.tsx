// icons.test.tsx (CHROME-01, plan 59-02) - the EMITTED MARKUP of every chrome icon
// export, over the FULL export surface rather than a sample.
//
// `icons.tsx` had no unit spec at all before this file. Its contract was held only by
// `chrome-icons.spec.ts`, which drives the real browser and can therefore say "there is
// an inline <svg> with some paths in it" but not "this `d` string is character-identical
// to the one in the committed file" - and character-identity IS the CHROME-01 claim.
//
// NODE ENVIRONMENT, NO DOM, NO NEW PACKAGE. Every icon export is a pure function, so it
// is INVOKED DIRECTLY and the returned React element tree is walked with the `isEl` /
// `findAll` shape copied from `PortIndicator.test.tsx:24-56`. A child in a returned tree
// is only a DESCRIPTOR and is never invoked, so the walker sees exactly the markup the
// icon itself emits and nothing a child component would add.
//
// WITH ONE EXPLICIT EXCEPTION, and it is the difference between this file and
// `PortIndicator.test.tsx`. Nineteen of the twenty exports here are one-line DELEGATIONS
// to a shared internal component, so the first invocation returns a descriptor and the
// real markup does not exist yet. `resolveRoot` (below) invokes function-typed ROOTS -
// and only roots - until the root is a host element. See its docblock for why that is a
// resolution step rather than a renderer.
//
// THE EXPORT LIST IS DERIVED FROM THE MODULE NAMESPACE, never hand-picked. A gate that
// iterates a typed list of names certifies the names somebody remembered, and the next
// export added is the one that escapes it. `Object.entries(icons)` cannot be escaped;
// the stated count below is the vacuity refusal on top of it.
//
// THE `d` COMPARISON IS RAW-STRING AND MUST STAY THAT WAY. No trim, no whitespace
// normalisation, no numeric canonicalisation. `10.0` and `10` are numerically equal and
// textually different, and a comparison that forgave the difference would let the DOM
// half and the canvas half drift apart while this file stayed green - which is the
// precise failure CHROME-01 is written against.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * source text -> how many times `iconElements` has parsed it, for the WHOLE lifetime of
 * this module graph: the import-time chrome walk plus every render below.
 *
 * `vi.hoisted` IS LOAD-BEARING AND IS NOT STYLE. `vi.mock` factories are hoisted above
 * every import in this file, so a plain module-scope `const` is still in its temporal
 * dead zone when the factory runs and the mock would throw on first parse. The counter
 * has to be created in a block that is hoisted with the mock.
 */
const parseCounts = vi.hoisted(() => new Map<string, number>());

/**
 * A COUNTING PASSTHROUGH, never a stub.
 *
 * Two properties, and both are the reason it is shaped this way. It is HOISTED, so the
 * thirteen parses `icons.tsx` performs at import time (the `CHROME_GLYPHS` table) are
 * counted rather than missed - a mock installed after the import would see zero of them
 * and the gate below would measure only the render path. And it SPREADS THE ACTUAL
 * MODULE and delegates to the real `iconElements`, so every other case in this file
 * (verbatim `d`, `data-part`, decorative attributes, the chassis) keeps measuring the
 * real parser rather than a fixture.
 */
vi.mock('./svgToElements.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./svgToElements.ts')>();
  return {
    ...actual,
    iconElements: (source: string, opts: Parameters<typeof actual.iconElements>[1]) => {
      parseCounts.set(source, (parseCounts.get(source) ?? 0) + 1);
      return actual.iconElements(source, opts);
    },
  };
});

import * as icons from './icons.tsx';
import { PortIndicator } from './PortIndicator.tsx';
import { machine_kind } from '../protocol/kinds.ts';
import { ART_ALIAS_OF, SUBJECT_OF } from '../render/layers/machines.ts';
import { chassisPathD, chassisSpec } from '../render/layers/machineChassis.ts';
import { LOCKED_SKIN } from '../render/synth/skins/locked.ts';
import { getAssetSource } from '../render/svgAssets.ts';
import { CHROME_ASSET_SOURCES, getChromeAssetSource, type ChromeAssetName } from './assets/registry.ts';

/* ------------------------------------------------------------------ *
 * The element-tree walker (PortIndicator.test.tsx:24-56, verbatim in shape)
 * ------------------------------------------------------------------ */

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}
function isEl(x: unknown): x is El {
  return typeof x === 'object' && x !== null && 'props' in x && 'type' in x;
}
function findAll(node: unknown, pred: (el: El) => boolean): El[] {
  const hits: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isEl(n)) return;
    if (pred(n)) hits.push(n);
    walk(n.props.children);
  };
  walk(node);
  return hits;
}
const everyEl = (node: unknown): El[] => findAll(node, () => true);

/* ------------------------------------------------------------------ *
 * The export surface
 * ------------------------------------------------------------------ */

/**
 * THE EXPORT COUNT, as a stated literal - never `Object.keys(icons).length`.
 *
 * The count is not what the gate checks; the ITERATION below is. This literal is the
 * vacuity refusal on top of it: a namespace import that resolved to nothing would iterate
 * zero exports and satisfy every assertion in this file by measuring none of them.
 *
 * 20 at plan 59-02: eleven DOM-only glyphs (Play, Pause, Step, Undo, Redo, Save, Load,
 * New, Fit, Warning, Trash), `MachineGlyphIcon`, and eight kind-keyed convenience
 * wrappers (Source, Sink, Factory, Tee, Balancer, Router, Merge, Belt). 20 -> 21 at plan
 * 61-06: the fader glyph, the twelfth DOM-only glyph, triggering the Graphics panel. 21 ->
 * 22 at plan 66-01: `WireIcon`, the thirteenth DOM-only glyph, drawing the Palette's Wire
 * tool. `WireIcon` is a CHROME glyph wrapper and NOT a kind wrapper - kind 8 (WIRE) has no
 * `SUBJECT_OF` key, so it cannot go through `MachineGlyphIcon` at all. There is
 * deliberately NO `EndpointIcon`: the endpoint is a `SUBJECT_OF` member with no palette
 * or legend entry, so it is reached through `MachineGlyphIcon` and covered by the
 * subject loop below rather than by a wrapper nothing calls. 22 -> 23 in phase 76 (plan
 * 76-01): `LabelIcon`, the fourteenth DOM-only glyph, drawing the Palette's Label row. A
 * CHROME glyph wrapper for the reason `WireIcon` is one: kind 11 has no `SUBJECT_OF` key.
 * 23 -> 22 in plan 91-03 on 2026-10-24 (the Graphics trigger's fader glyph deleted with the
 * Graphics panel, D-04): it had no other consumer (CHROME-03).
 */
const EXPECTED_ICON_EXPORTS = 22;

/**
 * The props one export needs that the others do not.
 *
 * `MachineGlyphIcon` is the only export whose signature is not bare `IconProps`. Keyed by
 * name and asserted to be a SUBSET of the real export list, so a rename leaves a dead
 * entry that reddens rather than a silently unexercised export.
 */
const PROPS_FOR: Readonly<Record<string, Record<string, unknown>>> = {
  MachineGlyphIcon: { kind: machine_kind.SOURCE },
};

type IconFn = (props: Record<string, unknown>) => unknown;

/**
 * Every exported icon component, by name, straight off the module namespace.
 *
 * The cast is to the LOOSE `IconFn` on purpose, and it is the point rather than a smell:
 * the exports have three different declared parameter types (`IconProps`,
 * `MachineIconProps`, and the internal narrowing) and this gate is deliberately blind to
 * all of them, because a signature-typed list is a list somebody wrote down. `PROPS_FOR`
 * is what supplies the one export that needs more than `{}`, and it is asserted to have
 * no dead entry.
 */
const EXPORTS: readonly (readonly [string, IconFn])[] = (
  Object.entries(icons) as (readonly [string, unknown])[]
)
  .filter((e): e is readonly [string, IconFn] => typeof e[1] === 'function')
  .sort((a, b) => a[0].localeCompare(b[0]));

/**
 * Invoke function-typed ROOTS until the root is a host element.
 *
 * WHY THIS IS NEEDED, AND WHY IT IS NOT A RENDERER. Nineteen of the twenty exports are
 * one-line delegations - `PlayIcon` returns `<ChromeGlyphIcon name="play" />`, `SourceIcon`
 * returns `<MachineGlyphIcon kind={SOURCE} />` - and a returned child is only a
 * DESCRIPTOR: React has not called it, so `PlayIcon({}).type` is the function itself and
 * the tree below it does not exist yet. Walking that tree would assert things about a
 * one-line wrapper and nothing about the markup a user sees.
 *
 * So the ROOT chain is resolved, explicitly, with a depth cap and a named throw - and
 * nothing else is. Descriptors deeper in the tree stay unresolved, which is the property
 * `PortIndicator.test.tsx` relies on and the reason this file needs no DOM and no
 * test-renderer package: after the root resolves, every remaining node in these trees is
 * a host element (`svg`, `g`, `path`) that the icon itself emitted.
 */
function resolveRoot(node: unknown, name: string): El {
  let cur = node;
  for (let depth = 0; depth < 8; depth++) {
    if (!isEl(cur)) throw new Error(`icons.test: ${name} returned a non-element at depth ${depth}`);
    if (typeof cur.type === 'string') return cur;
    if (typeof cur.type !== 'function') {
      throw new Error(`icons.test: ${name} root is neither a host element nor a component`);
    }
    cur = (cur.type as IconFn)(cur.props);
  }
  throw new Error(
    `icons.test: ${name} did not resolve to a host element within 8 levels. An icon is one ` +
      'delegation deep by construction; a chain this long means something else is going on.',
  );
}

/** One export's rendered tree, root resolved. */
function render(name: string, fn: IconFn): El {
  return resolveRoot(fn(PROPS_FOR[name] ?? {}), name);
}

/* ------------------------------------------------------------------ *
 * The eight machine subjects and their committed artwork
 * ------------------------------------------------------------------ */

const MACHINE_ASSET_DIR = join(import.meta.dirname, '..', 'render', 'assets');

/** The AUTHORED TEXT of one machine subject, read from DISK rather than through `?raw`. */
function subjectSource(asset: string): string {
  return readFileSync(join(MACHINE_ASSET_DIR, `${asset}.svg`), 'utf8');
}

/** THE chassis `d`, evaluated HERE from the shared spec - never a mirrored literal. */
const CHASSIS_D = chassisPathD(chassisSpec(1, 1, LOCKED_SKIN));

/** Every `<path>` in a tree, with its emitted attributes. */
function paths(tree: unknown): El[] {
  return findAll(tree, (el) => el.type === 'path');
}
const partOf = (el: El): string => String(el.props['data-part']);
const dOf = (el: El): string => String(el.props.d);

describe('every icon export emits a decorative inline <svg>', () => {
  it('iterates a non-empty, stated number of exports, and the props table has no dead entry', () => {
    expect(EXPORTS.length).toBeGreaterThan(0);
    expect(EXPORTS).toHaveLength(EXPECTED_ICON_EXPORTS);
    const names = new Set(EXPORTS.map(([n]) => n));
    for (const key of Object.keys(PROPS_FOR)) {
      expect(names, `PROPS_FOR names '${key}', which is not an export any more`).toContain(key);
    }
  });

  it('every root is an <svg> carrying aria-hidden="true" and focusable="false"', () => {
    for (const [name, fn] of EXPORTS) {
      const el = render(name, fn);
      expect(el.type, `${name}'s root element`).toBe('svg');
      expect(el.props['aria-hidden'], `${name} root aria-hidden`).toBe('true');
      // An inline <svg> is focusable in some engines' tab order even when aria-hidden,
      // which is a real keyboard-trap class this app guards against elsewhere (IX-09).
      expect(el.props.focusable, `${name} root focusable`).toBe('false');
    }
  });

  it('no icon renders a <title> and nothing in any tree carries role="img"', () => {
    for (const [name, fn] of EXPORTS) {
      const tree = render(name, fn);
      expect(
        findAll(tree, (el) => el.type === 'title'),
        `${name} renders a <title>, which gives a decorative glyph an accessible name`,
      ).toHaveLength(0);
      expect(
        findAll(tree, (el) => el.props.role === 'img'),
        `${name} carries role="img" somewhere in its tree`,
      ).toHaveLength(0);
    }
  });

  it('ZERO hex characters appear inside any fill or stroke, over the FULL export surface', () => {
    // Not a sample. The machine subjects DO carry an authored `#b0bacb` on disk and it is
    // rewritten to `currentColor` by `svgToElements`; the chrome glyphs are authored
    // token-only. Both halves are asserted by the same loop over the same list, so
    // neither can be the one that was not checked.
    const offenders: string[] = [];
    for (const [name, fn] of EXPORTS) {
      for (const el of everyEl(render(name, fn))) {
        for (const attr of ['fill', 'stroke'] as const) {
          const value = el.props[attr];
          if (typeof value === 'string' && value.includes('#')) {
            offenders.push(`${name} ${String(el.type)}[${attr}]="${value}"`);
          }
        }
      }
    }
    expect(
      offenders,
      'A baked hex in the DOM does not desaturate with a disabled button and does not ' +
        'lift with a hovered palette item, and it does neither SILENTLY.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('every export emits at least one <path> - a mounted, empty <svg> is an invisible icon', () => {
    for (const [name, fn] of EXPORTS) {
      expect(paths(render(name, fn)).length, `${name} emitted no <path>`).toBeGreaterThan(0);
    }
  });
});

describe('the machine icons carry their subject artwork VERBATIM', () => {
  /** The nine `SUBJECT_OF` kinds, derived from the shipped table at test time. */
  const subjects = Object.entries(SUBJECT_OF).map(([kind, asset]) => [Number(kind), asset] as const);

  it('covers all NINE subjects, derived from SUBJECT_OF rather than typed', () => {
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects).toHaveLength(9);
    // BELT is deliberately absent from this keyspace and resolves through the CHROME
    // registry instead. `machines.ts`'s header warns at length that the matching count of
    // 8 between `SUBJECT_OF` and `GEN_KEY_OF` is a trap; this is the assertion that keeps
    // the two from being quietly unified.
    expect(subjects.map(([kind]) => kind)).not.toContain(machine_kind.BELT);
    expect(subjects.map(([kind]) => kind)).toContain(machine_kind.ENDPOINT);
  });

  it('every emitted glyph `d` appears CHARACTER-IDENTICALLY in its subject .svg on disk', () => {
    for (const [kind, asset] of subjects) {
      const source = subjectSource(asset);
      const glyphs = paths(resolveRoot(icons.MachineGlyphIcon({ kind }), 'MachineGlyphIcon')).filter((p) => partOf(p) !== 'chassis');
      expect(glyphs.length, `${asset} emitted no glyph part`).toBeGreaterThan(0);
      for (const p of glyphs) {
        // RAW STRING CONTAINMENT. Deliberately no trim, no whitespace normalisation and
        // no numeric canonicalisation: `V 22` and `V 22.0` are the same rectangle and
        // different text, and a forgiving comparison would let the icon and the canvas
        // drift while this stayed green.
        //
        // ANCHORED ON THE ATTRIBUTE, matching the chrome half at :337 (phase 59 review
        // IN-02). This was a BARE `source.includes(dOf(p))`, which passes if the string
        // appears ANYWHERE in the file - including as a PREFIX of the real value, and
        // including inside the 40-to-80-line provenance header, where these assets quote
        // `d` values in order to discuss them. MEASURED: with the parser truncating every
        // emitted `d` by two characters, the anchored form reddens TWO cases and the bare
        // form only one - the machine half is the case that flips, because a truncated
        // `d` is still a substring of its own source attribute.
        expect(
          source.includes(`d="${dOf(p)}"`),
          `${asset}: the icon emits d="${dOf(p)}" for part '${partOf(p)}', which does not ` +
            `appear character-identically in render/assets/${asset}.svg. The comparison is ` +
            'RAW: a whitespace-only or numerically-equivalent difference is a FAIL, because ' +
            'a normalising comparison is exactly how two surfaces drift while their gate ' +
            'stays green.',
        ).toBe(true);
      }
    }
  });

  it("the chassis `d` comes from the SHARED spec, evaluated here - not from a mirrored literal", () => {
    for (const [kind, asset] of subjects) {
      const chassis = paths(resolveRoot(icons.MachineGlyphIcon({ kind }), 'MachineGlyphIcon')).filter((p) => partOf(p) === 'chassis');
      expect(chassis, `${asset} draws exactly one chassis`).toHaveLength(1);
      // ONE DECLARATION, not two that agree. `chassisPathD(chassisSpec(1, 1, LOCKED_SKIN))`
      // is called in THIS file, so a change to `CHASSIS_INSET_U` moves the expectation and
      // the icon together rather than letting one silently track the other. That is also
      // why the value is not written out as a string here.
      expect(dOf(chassis[0]!)).toBe(CHASSIS_D);
    }
  });

  it('BELT emits NO chassis, because a belt has no chassis on canvas', () => {
    const belt = paths(render('BeltIcon', icons.BeltIcon as IconFn));
    expect(belt.length).toBeGreaterThan(0);
    expect(belt.map(partOf)).not.toContain('chassis');
    // ... and its glyph comes from the CHROME directory, verbatim, the same way.
    const source = readFileSync(join(import.meta.dirname, 'assets', 'belt.svg'), 'utf8');
    for (const p of belt) expect(source.includes(dOf(p)), `belt part '${partOf(p)}'`).toBe(true);
  });

  it('an unresolved kind byte draws the bare chassis rather than throwing inside a render', () => {
    // Totality over the wire byte, the property `MachineGlyphIcon`'s docblock claims.
    // `machine_kind.WIRE` (8) is a real byte with no `SUBJECT_OF` entry.
    const wire = paths(resolveRoot(icons.MachineGlyphIcon({ kind: machine_kind.WIRE }), 'MachineGlyphIcon'));
    expect(wire.map(partOf)).toEqual(['chassis']);
  });
});

describe('the DOM-only chrome glyphs carry their chrome artwork VERBATIM', () => {
  /**
   * Export name -> the `chrome/assets/` file it must draw. A typed table HERE is correct
   * where it would be wrong above: the property under test is the WIRING (does `SaveIcon`
   * draw `save.svg`, or has someone crossed two rows of the registry?), and a wiring
   * assertion derived from the wiring cannot fail.
   */
  const WIRED: Readonly<Record<string, string>> = {
    PlayIcon: 'play',
    PauseIcon: 'pause',
    StepIcon: 'step',
    UndoIcon: 'undo',
    RedoIcon: 'redo',
    SaveIcon: 'save',
    LoadIcon: 'load',
    NewIcon: 'new',
    FitIcon: 'fit',
    WarningIcon: 'warning',
    TrashIcon: 'trash',
    WireIcon: 'wire',
    LabelIcon: 'label',
  };

  it('draws the right file, with every `d` and every `data-part` character-identical to it', () => {
    for (const [exportName, asset] of Object.entries(WIRED)) {
      const fn = (icons as unknown as Record<string, IconFn>)[exportName];
      expect(fn, `${exportName} is no longer exported`).toBeTypeOf('function');
      const source = readFileSync(join(import.meta.dirname, 'assets', `${asset}.svg`), 'utf8');
      const emitted = paths(resolveRoot(fn({}), exportName));
      expect(emitted.length, `${exportName} emitted no <path>`).toBeGreaterThan(0);
      for (const p of emitted) {
        expect(source.includes(`d="${dOf(p)}"`), `${exportName} -> ${asset}.svg, d`).toBe(true);
        expect(
          source.includes(`data-part="${partOf(p)}"`),
          `${exportName} -> ${asset}.svg, data-part '${partOf(p)}'`,
        ).toBe(true);
      }
    }
    // Every DOM-only export is wired, and the thirteen above plus MachineGlyphIcon plus
    // the eight kind wrappers are the whole surface.
    expect(Object.keys(WIRED)).toHaveLength(EXPECTED_ICON_EXPORTS - 9);
  });

  it('no chrome glyph emits a chassis, and none is placed through a transform', () => {
    for (const exportName of Object.keys(WIRED)) {
      const fn = (icons as unknown as Record<string, IconFn>)[exportName]!;
      const tree = resolveRoot(fn({}), exportName);
      expect(paths(tree).map(partOf), `${exportName} chassis`).not.toContain('chassis');
      // A chrome asset is authored IN the icon box, so there is nothing to place. A `<g>`
      // here would mean the two families' code paths had been merged back together.
      expect(findAll(tree, (el) => el.type === 'g'), `${exportName} <g> wrapper`).toHaveLength(0);
    }
  });

  it('WarningIcon defaults to the destructive tint and every other glyph to --fab-ink', () => {
    const colorOf = (name: string): unknown =>
      resolveRoot((icons as unknown as Record<string, IconFn>)[name]!({}), name).props.style;
    for (const name of Object.keys(WIRED)) {
      const style = colorOf(name) as { color?: string };
      expect(style.color, `${name} default ink`).toBe(
        name === 'WarningIcon' ? 'var(--fab-destructive)' : 'var(--fab-ink)',
      );
    }
    // The default is a DEFAULT and not a bake: a caller's colour still wins, which is what
    // lets the guard dialogs draw the same artwork in the inherited panel ink.
    const overridden = resolveRoot(icons.WarningIcon({ color: 'currentColor' }), 'WarningIcon');
    expect((overridden.props.style as { color?: string }).color).toBe('currentColor');

    // AN EXPLICIT `undefined` IS NOT AN OVERRIDE (phase 59 review WR-09), and it is the
    // half a defined-colour case cannot see. While the wrapper was
    // `<ChromeGlyphIcon color="var(--fab-destructive)" {...p} />`, the spread carried
    // `color: undefined` through as a PRESENT KEY and clobbered the default, so
    // `<WarningIcon color={cond ? tint : undefined} />` - the shape that reads as "no
    // override" - silently resolved to `var(--fab-ink)` and the warning lost its fault
    // hue. A default PARAMETER treats a missing key and an explicit `undefined`
    // identically, which is what the wrapper's docblock always claimed.
    const explicitUndefined = resolveRoot(
      icons.WarningIcon({ color: undefined }),
      'WarningIcon',
    );
    expect(
      (explicitUndefined.props.style as { color?: string }).color,
      'an explicit undefined colour keeps the destructive default',
    ).toBe('var(--fab-destructive)');
  });
});

/* ------------------------------------------------------------------ *
 * ONE PARSE PER ASSET (plan 59-08, closing 59-VERIFICATION.md gap 1)
 * ------------------------------------------------------------------ */

describe('every asset is parsed exactly ONCE, no matter how many icons render', () => {
  /**
   * The number of renders each subject gets. Five, matching the verifier's probe: it
   * measured 0 parses for five `PlayIcon` renders and 5 for five `TeeIcon` renders, and
   * this gate is the tree's copy of that measurement.
   */
  const RENDERS = 5;

  /**
   * Asset source text -> a readable label, DERIVED from the two registries rather than
   * typed. Only used to make a failure name its offender; the assertions below never
   * read it.
   */
  const labelOf = new Map<string, string>();
  for (const name of Object.keys(CHROME_ASSET_SOURCES) as ChromeAssetName[]) {
    labelOf.set(getChromeAssetSource(name), `chrome/assets/${name}.svg`);
  }
  for (const asset of Object.values(SUBJECT_OF)) {
    labelOf.set(getAssetSource(asset), `render/assets/${asset}.svg`);
  }

  it('parses each asset once across import plus five renders of the WHOLE surface', () => {
    // Drive the renders through this file's OWN `render()` helper, which resolves the
    // root chain. A bare `TeeIcon({})` returns a DESCRIPTOR: React has not called the
    // component, nothing is parsed, and a gate built on it would pass on nothing.
    for (let i = 0; i < RENDERS; i++) {
      for (const [name, fn] of EXPORTS) render(name, fn);
      // The export surface alone does not reach ENDPOINT, which has a `SUBJECT_OF` entry
      // and deliberately no convenience wrapper. Every kind, not every export.
      for (const kind of Object.keys(SUBJECT_OF).map(Number)) {
        resolveRoot(icons.MachineGlyphIcon({ kind }), 'MachineGlyphIcon');
      }
    }

    // THE VACUITY REFUSAL, and it is the assertion that makes the rest mean anything. If
    // the hoisted mock ever failed to intercept, `parseCounts` would be EMPTY and "no
    // entry exceeds one" would pass while measuring zero parses. The expectation is
    // DERIVED from the two registries - 13 chrome assets + 9 machine subjects MINUS the
    // 1 declared art alias today - never typed, so a fourteenth asset is covered the
    // moment it is registered.
    //
    // THE SUBTRACTION IS THE ALIAS CLAUSE, and it is a rewrite rather than a bumped
    // literal (plan 72-09, R-58). `SUBJECT_OF` now carries nine kinds, but HANDLER is a
    // DECLARED alias of the FACTORY, so it resolves to the SAME asset source and the spy
    // sees one parse, not two. Writing `+ 1` here, or relaxing `.toBe` to
    // `.toBeGreaterThan(0)`, would restore green while destroying the only thing this
    // number does: it is what catches "two assets have identical source text", i.e. two
    // kinds accidentally sharing art. Subtracting the DECLARED aliases keeps that
    // catch at full strength for every kind that is not one, and makes a new accidental
    // duplicate reddened by exactly the message below.
    //
    // MUTATION PROOF, run 2026-09-03 and reverted. `ART_ALIAS_OF` emptied to `{}`:
    //
    //     × parses each asset once across import plus five renders of the WHOLE surface
    //       AssertionError: the spy saw 23 distinct asset sources, not the 24 the two
    //       registries declare. Either an asset is unreachable from the export surface
    //       and the SUBJECT_OF loop, or two assets have identical source text (and is
    //       not declared in ART_ALIAS_OF).: expected 23 to be 24
    //
    // The SAME mutation, and the same message, also fires when a tenth kind is given
    // `SUBJECT_OF['factory']` with no alias row - which is the accidental duplicate this
    // count has always existed to catch, still caught at full strength.
    //
    // So the subtraction is load-bearing rather than cosmetic: without a real alias row
    // behind it the count is wrong and this gate says so.
    const aliasedSubjects = Object.keys(ART_ALIAS_OF)
      .map(Number)
      .filter((kind) => Object.hasOwn(SUBJECT_OF, kind));
    const expectedSources =
      Object.keys(CHROME_ASSET_SOURCES).length +
      Object.keys(SUBJECT_OF).length -
      aliasedSubjects.length;
    expect(
      parseCounts.size,
      parseCounts.size === 0
        ? 'the iconElements spy never intercepted: this gate measured NOTHING. The vi.mock ' +
          'path must resolve to the same module icons.tsx imports.'
        : `the spy saw ${parseCounts.size} distinct asset sources, not the ${expectedSources} ` +
          'the two registries declare. Either an asset is unreachable from the export ' +
          'surface and the SUBJECT_OF loop, or two assets have identical source text ' +
          '(and is not declared in ART_ALIAS_OF).',
    ).toBe(expectedSources);

    // ...and the subtraction is not a free pass. Every kind it removes must ACTUALLY
    // resolve to its alias's asset: an alias row that drifts off its target would
    // otherwise silently buy back exactly the count it costs.
    expect(aliasedSubjects.length, 'ART_ALIAS_OF names no SUBJECT_OF kind, so the ' +
      'subtraction above is a no-op dressed as a rule').toBeGreaterThan(0);
    for (const kind of aliasedSubjects) {
      expect(
        SUBJECT_OF[kind],
        `kind ${kind} is declared an art alias of ${ART_ALIAS_OF[kind]}, so it must ` +
          'resolve to the SAME asset, and it does not',
      ).toBe(SUBJECT_OF[ART_ALIAS_OF[kind]]);
    }

    const overParsed = [...parseCounts.entries()]
      .filter(([, n]) => n > 1)
      .map(([source, n]) => `${labelOf.get(source) ?? '<unlabelled source>'} parsed ${n}x`)
      .sort();
    expect(
      overParsed,
      'An asset was parsed more than once. `CHROME_GLYPHS` (eager, at import) and ' +
        '`PLACED_GLYPHS` (lazy, at first render) are the two memos that make ' +
        "`icons.tsx`'s stated invariant true: N icons on one screen share ONE parse per " +
        'asset. This is 59-VERIFICATION.md gap 1, which was MEASURED at five parses for ' +
        'five renders of a machine glyph.\n' +
        overParsed.join('\n'),
    ).toEqual([]);
  });

  it('holds for BOTH families by name: the two subjects the verifier measured', () => {
    // Resolved through the registries rather than re-read from disk, so this names the
    // same bytes the module parses. The verifier measured chrome 0 / machine 5 across
    // five renders; both are 1 across the module's whole lifetime now.
    const play = getChromeAssetSource('play');
    const tee = getAssetSource('tee');
    expect(parseCounts.get(play), 'chrome/assets/play.svg parses (eager, at import)').toBe(1);
    expect(parseCounts.get(tee), 'render/assets/tee.svg parses (lazy, at first render)').toBe(1);
  });
});

// Phase 91, plan 91-10 (CHROME-20, D-16, UI-SPEC 7.1, WINDOWS 233): every chrome icon is drawn
// with anti-aliasing. `crispEdges` snapped each glyph's edges to whole device pixels, so at the
// user's 1.18 text scale (a fractional device scale) two mirrored glyphs at different sub-pixel
// phases snapped differently: Undo and Redo stopped being mirrors and the arrows stair-stepped.
// `geometricPrecision` is the hint the lockup already carries (plan 80.1-04). The pixel proof is
// `e2e/icon-mirror.spec.ts`; this pins the declaration on every root, so the change is guarded
// (nothing pinned `crispEdges` before, research Finding J).
describe('every chrome icon root renders with geometricPrecision (plan 91-10, CHROME-20)', () => {
  it('every ChromeGlyphIcon and MachineGlyphIcon export, over the full surface', () => {
    const wrong: string[] = [];
    for (const [name, fn] of EXPORTS) {
      const st = (render(name, fn).props.style ?? {}) as Record<string, unknown>;
      if (st.shapeRendering !== 'geometricPrecision') wrong.push(`${name}: ${String(st.shapeRendering)}`);
    }
    expect(wrong).toEqual([]);
    expect(EXPORTS.length, 'NON-VACUITY: the exports were iterated').toBeGreaterThan(0);
  });

  it('and the inspector port row glyph, PortIndicator, for every role', () => {
    for (const role of [0, 1, 2]) {
      const el = PortIndicator({ role }) as unknown as { type: unknown; props: { style?: Record<string, unknown> } };
      expect(el.type).toBe('svg');
      expect(el.props.style?.shapeRendering, `PortIndicator role ${role}`).toBe('geometricPrecision');
    }
  });
});
