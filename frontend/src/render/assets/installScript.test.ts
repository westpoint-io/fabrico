// installScript.test.ts - the gate over `scripts/install-local-bundle.sh`, the only script in
// this repository that writes into the developer's home directory (ICON-02, D-09, T-81-22,
// T-81-23, plan 81-05, rewritten to close 81-REVIEW.md CR-01, CR-02 and WR-11).
//
// WHY A GATE AT ALL. Every other script here writes inside the repository, where `git checkout`
// is the undo. This one copies a built package payload into `~/.local/`, outside any package
// manager's knowledge, and its only undo is its own second subcommand.
//
// WHAT THE FIRST VERSION OF THIS FILE GOT WRONG, recorded because it is this repository's
// signature defect and this file was an instance of it. Every case was a GREP OVER THE SCRIPT
// TEXT. Eight mutants of the script were run through those predicates in review and SEVEN
// PASSED GREEN, including an `rm -rf` of the shared icon tree spelled `${HOME}` instead of
// `$HOME`, the same removal spelled `~/`, an uninstall that removed nothing, and a pruning walk
// switched from `rmdir` to `rm -rf`. The one mutant that reddened it was an edit to the help
// text. The case titled "the uninstall's removal set equals the install's creation set" was the
// clearest instance: it grepped both function bodies for the substring `PAYLOAD_MAP[@]` and, if
// present, returned all four declared destinations regardless of what either body did with
// them, so the assertion was `[4 items] === [4 items]` and could not tell an uninstall that
// removed everything from one that removed nothing.
//
// A GREP OVER A FUNCTION BODY IS NOT A BEHAVIOURAL CLAIM. So this file now has two halves:
//
//   PART 1, the text walk. Still worth having - it is the only thing that can say "no shared
//   directory is ever named" about a line that never runs on this machine - but it is now
//   honest about its reach. It bans the SPELLINGS its own predicates cannot see, it bounds
//   every `rm` by the ONE function that is allowed to contain one, and every predicate returns
//   a MESSAGE that a mutation case asserts on.
//
//   PART 2, the execution walk, and this is the half that carries the claim. It builds a
//   fixture payload and a THROWAWAY HOME under `mkdtemp`, runs the real script against them
//   with `HOME` redirected, and asserts on the tree that is left behind. The invariant is one
//   predicate, `cycleComplaint`, and the mutation cases run the SAME predicate against mutants
//   and watch it complain. Three of the four mutants below are the ones review measured
//   passing green.
//
// NEVER THE REAL HOME DIRECTORY. `freshHome()` refuses to hand back a path that is not under
// `mkdtemp`'s root or that equals the invoking user's own `HOME`, and every `spawnSync` below
// passes an explicit `HOME`. A spec that touched the developer's actual home directory would
// be a worse defect than the one it was written to catch.
//
// WHY IT EXECUTES BASH AT ALL, given that this is a vitest file. Because there is nowhere else
// for it to live: CI runs `npx vitest run` in the `unit` job on ubuntu-latest and runs no shell
// suite. `spawnSync('bash', ...)` is available there and here. The script's own external
// commands (`gtk-update-icon-cache`, `update-desktop-database`) already swallow their status,
// so their absence on a runner changes nothing.
//
// No `@vitest-environment` docblock. The project default is the node environment, which is what
// lets this spec read from disk, spawn a process and resolve paths from `import.meta.dirname`.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* ------------------------------------------------------------------ *
 * The subject, read from disk
 * ------------------------------------------------------------------ */

/**
 * `scripts/install-local-bundle.sh`. Four levels up from `render/assets/` is the repository
 * root: `assets` -> `render` -> `src` -> `frontend`.
 */
const SCRIPT_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'install-local-bundle.sh',
);

const REPO_ROOT = resolve(SCRIPT_PATH, '..', '..');

const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

/**
 * The name of the one declared list. Both directions of the script read it; nothing else in this
 * file assumes anything about its CONTENTS.
 */
const DECLARED_ARRAY = 'PAYLOAD_MAP';

/**
 * The name of the ownership record's path constant. It is a declared destination in every sense
 * that matters - the install creates it and the uninstall removes it - but it has no payload
 * source, so it cannot be a `PAYLOAD_MAP` record. Named here so the undeclared-path walk below
 * can forgive exactly this one path and nothing else.
 */
const MANIFEST_CONSTANT = 'MANIFEST_PATH';

/** The one function permitted to contain an `rm`. See `removalsOutside`. */
const REMOVAL_FUNCTION = 'remove_path';

/** The pruning walk, which may `rmdir` and must never `rm`. */
const PRUNE_FUNCTION = 'prune_recorded_dirs';

/**
 * Directory suffixes a recursive removal may NEVER end in, because each is shared with software
 * this repository did not install. These are facts about the machine, which is why they are
 * literals here and not derived from the script.
 */
const SHARED_DIRECTORY_SUFFIXES = [
  '$HOME',
  '$HOME/',
  '$HOME/.local',
  '$HOME/.local/share',
  '$HOME/.local/bin',
  '$HOME/.local/lib',
  '$HOME/.local/share/icons',
  '$HOME/.local/share/applications',
  '$HOME/.local/share/icons/hicolor',
];

/**
 * What the declared list has to cover, BY NAME rather than by count.
 *
 * This replaces a `MIN_DESTINATIONS = 4` floor. A count is the anti-vacuity device this project
 * has recorded three times as the wrong one: it binds nothing about the list's contents, so the
 * icon record could be swapped for anything and every case stayed green. Each shape below names
 * a part of the Debian payload and the assertion says which one is missing.
 *
 * The behavioural half of this file is the second, independent half of the same claim: the
 * fixture payload is built from `PAYLOAD_FIXTURE` and the install refuses a payload that does
 * not satisfy every declared record, so a swapped record reddens Part 2 as well as Part 1.
 */
const REQUIRED_DESTINATION_SHAPES = [
  { name: 'the executable', match: /\/\.local\/bin\// },
  { name: 'the desktop entry', match: /\/\.local\/share\/applications\/.*\.desktop$/ },
  { name: 'the hicolor icon glob', match: /\/\.local\/share\/icons\/hicolor\/\*\/apps\/.*\.png$/ },
  { name: 'the bundled resource directory', match: /\/\.local\/lib\// },
  { name: 'the ownership manifest', match: /\/\.local\/share\/.*\/install-manifest$/ },
] as const;

/* ------------------------------------------------------------------ *
 * PART 1 - the readers and the text predicates
 * ------------------------------------------------------------------ */

/**
 * Drops the script's PROSE: whole-line comments, and the body of any single-quoted heredoc.
 *
 * Comments, because a warning that NAMES the shared icon tree in order to forbid touching it
 * must not trip the very gate it is warning about. Only leading-`#` lines go, so a destructive
 * line cannot hide behind a trailing `#`.
 *
 * The heredoc, because `usage()` prints help text and help text is not an operand. This is the
 * other half of the CR-01 defect: the ONE mutant that reddened the old gate was an edit to the
 * help text, which is the shape that teaches an executor to edit assertions. It also unblocks
 * the `~/` ban below, since the help text legitimately writes `~/.local` for a human to read.
 *
 * Only SINGLE-QUOTED heredocs are dropped, because those are the ones with no expansion in
 * them at all. `assertProseStripperIsHonest` below proves this function actually removes the
 * usage text rather than silently matching nothing.
 */
function stripProse(source: string): string {
  const kept: string[] = [];
  let delimiter: string | null = null;
  for (const line of source.split('\n')) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    const opened = /<<'([A-Za-z_][A-Za-z0-9_]*)'/.exec(line);
    if (opened !== null) {
      delimiter = opened[1];
      kept.push(line.slice(0, opened.index));
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * The declared destinations, parsed out of the one array literal, plus the manifest constant.
 *
 * Each record is `<payload-relative source>|<destination>`; the destination is the half this
 * spec cares about. The array is located by its opening line and closed by a line that is
 * exactly `)`, the same block shape the declared-moves gate used for its covered crates
 * and for the same reason: a list a second tool has to read must be readable without a shell
 * parser.
 */
function declaredDestinations(source: string): string[] {
  const lines = stripProse(source).split('\n');
  const destinations: string[] = [];

  const open = lines.findIndex((line) => line.trim() === `${DECLARED_ARRAY}=(`);
  if (open !== -1) {
    for (let i = open + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === ')') break;
      const record = line.replace(/^"|"$/g, '');
      const bar = record.indexOf('|');
      if (bar === -1) continue;
      destinations.push(record.slice(bar + 1).trim());
    }
  }

  const manifest = new RegExp(`^${MANIFEST_CONSTANT}="([^"]+)"`, 'm').exec(stripProse(source));
  if (manifest !== null) destinations.push(manifest[1]);

  return destinations;
}

/**
 * The payload-relative source halves of the declared list, in declaration order.
 */
function declaredSources(source: string): string[] {
  const lines = stripProse(source).split('\n');
  const open = lines.findIndex((line) => line.trim() === `${DECLARED_ARRAY}=(`);
  if (open === -1) return [];
  const sources: string[] = [];
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === ')') return sources;
    const record = line.replace(/^"|"$/g, '');
    const bar = record.indexOf('|');
    if (bar === -1) continue;
    sources.push(record.slice(0, bar).trim());
  }
  return sources;
}

/**
 * The diagnosis, or `null`: every spelling of the home directory that the path predicates below
 * cannot see.
 *
 * `${HOME}` and `~/` are not style choices, they are HOLES. Review measured an `rm -rf` of the
 * shared icon tree passing green in both of those spellings while the identical `$HOME` one was
 * rejected. Normalising them would work too; banning them is stronger, because it also stops a
 * reader of the script from believing the predicates cover a spelling they do not.
 */
function unseenHomeSpellings(source: string): string | null {
  const body = stripProse(source);
  const found: string[] = [];
  if (/\$\{HOME\}/.test(body)) found.push('${HOME}');
  if (/(^|[\s"'(=])~\//m.test(body)) found.push('~/');
  if (found.length === 0) return null;
  return `home directory spelled in a way the path predicates cannot see: ${found.join(', ')}`;
}

/**
 * Every `$HOME`-rooted path the script text mentions, prose dropped. The character class stops
 * at whitespace and at the shell metacharacters that end a word, so `"$HOME/.local/bin/x"` and
 * `$HOME/.local/bin/x;` both yield the same path.
 */
function homePathsMentioned(source: string): string[] {
  const matches = stripProse(source).match(/\$HOME\/[^\s"'|)$;]*/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/\/+$/, '')))];
}

/**
 * The diagnosis, or `null`: every `$HOME`-rooted path the script mentions that is NOT a declared
 * destination. A parent directory is not an exception - the script derives those with `dirname`
 * from the declared entries precisely so that this walk has nothing to forgive.
 */
function undeclaredHomePaths(source: string): string | null {
  const declared = new Set(declaredDestinations(source));
  const stray = homePathsMentioned(source).filter((path) => !declared.has(path));
  if (stray.length === 0) return null;
  return `undeclared $HOME path(s) in the script: ${stray.join(', ')}`;
}

/**
 * The diagnosis, or `null`: every recursive removal whose operand is a LITERAL shared directory.
 *
 * Kept from the first version of this file, and kept honest about its reach: it sees literal
 * operands only. The variable-operand case, which is every actual removal in the script, is
 * `removalsOutside` below plus the script's own runtime prefix guard.
 */
function destructiveRemovals(source: string): string | null {
  const found: string[] = [];
  const stripped = stripProse(source).replace(/["']/g, '');
  for (const match of stripped.matchAll(/rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+([^\s;&|)]+)/g)) {
    const operand = match[1].replace(/\/+$/, '');
    if (SHARED_DIRECTORY_SUFFIXES.includes(operand)) {
      found.push(operand);
    }
  }
  if (found.length === 0) return null;
  return `recursive removal of shared directory: ${found.join(', ')}`;
}

/** A named function's body span within the prose-stripped source, as character offsets. */
function functionSpan(
  stripped: string,
  name: string,
): { start: number; end: number; body: string } | null {
  const lines = stripped.split('\n');
  const open = lines.findIndex((line) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(line.trim()));
  if (open === -1) return null;
  let close = -1;
  for (let i = open + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '}') {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  return {
    start: lines.slice(0, open + 1).join('\n').length + 1,
    end: lines.slice(0, close).join('\n').length,
    body: lines.slice(open + 1, close).join('\n'),
  };
}

/** Every `rm` invocation in the prose-stripped source, with its offset. `rmdir` is not one. */
function removalSites(stripped: string): { at: number; text: string }[] {
  const sites: { at: number; text: string }[] = [];
  for (const match of stripped.matchAll(/(?:^|[\s;&|(])rm\s+[^\n]*/g)) {
    sites.push({ at: match.index ?? 0, text: match[0].trim() });
  }
  return sites;
}

/**
 * The diagnosis, or `null`: every `rm` that is not inside the one function allowed to contain
 * one.
 *
 * THIS IS THE PREDICATE THAT REPLACES THE OLD VACUOUS PAIR. Every real removal in this script
 * has a VARIABLE operand, which no text gate can bound; the old file said so in a comment and
 * then delegated the case to a `$HOME`-literal walk that could not see it. The answer is
 * structural instead: there is exactly one `rm` in the file, its operand is checked at runtime
 * against the user prefix, and every other function has to go through it. A spliced `rm -rf`
 * anywhere else - including into the pruning walk, which is mutant F from the review - is named
 * here by its own text.
 */
function removalsOutside(source: string, name: string): string | null {
  const stripped = stripProse(source);
  const span = functionSpan(stripped, name);
  if (span === null) {
    return `the script has no ${name}() function, so no removal in it can be bounded`;
  }
  const stray = removalSites(stripped)
    .filter((site) => site.at < span.start || site.at >= span.end)
    .map((site) => site.text);
  if (stray.length === 0) return null;
  return `removal(s) outside ${name}(): ${stray.join(' | ')}`;
}

/* ------------------------------------------------------------------ *
 * PART 2 - the execution harness
 * ------------------------------------------------------------------ */

/**
 * The payload a real `tauri build --bundles deb` produces, as the paths this fixture writes.
 *
 * This is the spec's own declaration of what a bundle contains, and it is INDEPENDENT of the
 * script's `PAYLOAD_MAP`: the install fails naming any declared record that matches nothing
 * here, so a record swapped for a path a Debian payload does not carry reddens Part 2.
 */
const PAYLOAD_FIXTURE = [
  'usr/bin/fabrico-app',
  'usr/share/applications/Fabrico.desktop',
  'usr/share/icons/hicolor/16x16/apps/fabrico-app.png',
  'usr/share/icons/hicolor/48x48/apps/fabrico-app.png',
  'usr/share/icons/hicolor/256x256@2/apps/fabrico-app.png',
  'usr/lib/Fabrico/attribution/NOTICE.md',
] as const;

/**
 * Files planted in the throwaway home BEFORE the install, standing in for the software this
 * script did not put there.
 *
 * Two are inside the shared icon tree, one of them in a size bucket the payload also writes to,
 * because that tree is the single most damaging operand available in this script. `index.theme`
 * sits at the root of it, one level above anything the install touches.
 */
const CONTROLS_BEFORE = [
  '.local/share/icons/hicolor/index.theme',
  '.local/share/icons/hicolor/48x48/apps/another-application.png',
  '.local/share/icons/hicolor/22x22/apps/another-application.png',
] as const;

/**
 * A file planted AFTER the install, inside a directory the install itself created.
 *
 * This is the case a manifest-driven uninstall has to get right and a prefix-driven one cannot:
 * `~/.local/bin` may not have existed before the install, so the install owns it - right up
 * until the developer drops their own tool in beside ours. The uninstall must remove our
 * binary, leave theirs, and fail to prune the directory because it is no longer empty.
 */
const CONTROL_AFTER = '.local/bin/a-tool-the-user-added';

let scratchRoot: string;

beforeAll(() => {
  scratchRoot = mkdtempSync(join(tmpdir(), 'fabrico-install-gate-'));
});

afterAll(() => {
  rmSync(scratchRoot, { recursive: true, force: true });
});

/** A throwaway home directory, proven not to be the invoking user's. */
function freshHome(label: string): string {
  const home = mkdtempSync(join(scratchRoot, `${label}-home-`));
  expect(home.startsWith(scratchRoot), 'the throwaway home escaped the scratch root').toBe(true);
  expect(
    home,
    'the throwaway home resolved to the invoking user\'s real HOME, which this spec must never touch',
  ).not.toBe(process.env.HOME);
  return home;
}

/** Write a fixture payload and return its root. */
function freshPayload(label: string, files: readonly string[] = PAYLOAD_FIXTURE): string {
  const root = mkdtempSync(join(scratchRoot, `${label}-payload-`));
  for (const relative of files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture ${relative}\n`, 'utf8');
  }
  return root;
}

/** Write a copy of the script text and return its path. */
function scriptCopy(label: string, text: string): string {
  const path = join(mkdtempSync(join(scratchRoot, `${label}-script-`)), 'install-local-bundle.sh');
  writeFileSync(path, text, 'utf8');
  return path;
}

/** Every path under `root`, relative and sorted. Directories are listed as well as files. */
function listTree(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      found.push(relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(join(directory, entry.name), `${relative}/`);
      }
    }
  };
  walk(root, '');
  return found.sort();
}

/** `a/b/c` -> `['a', 'a/b']`. Used to expect the directories a planted control needs. */
function ancestorsOf(relative: string): string[] {
  const parts = relative.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the script with `HOME` redirected. Never inherits the invoking user's `HOME`. */
function runScript(scriptPath: string, home: string, args: readonly string[]): Run {
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

interface CycleReport {
  install: Run;
  uninstall: Run;
  installedPaths: string[];
  residue: string[];
  destroyed: string[];
}

/**
 * Install and then uninstall against a throwaway home, and report what the home directory looks
 * like afterwards against what it looked like before.
 *
 * `expected` is the pre-install listing plus the control planted after the install and the
 * directories it needs, because that control is supposed to SURVIVE. Everything else that is
 * present afterwards is residue, and everything expected that is absent was destroyed.
 */
function runCycle(label: string, scriptText: string): CycleReport {
  const home = freshHome(label);
  const payload = freshPayload(label);
  const script = scriptCopy(label, scriptText);

  for (const relative of CONTROLS_BEFORE) {
    const target = join(home, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `control ${relative}\n`, 'utf8');
  }

  const before = listTree(home);
  const install = runScript(script, home, ['install', '--payload', payload]);
  const afterInstall = listTree(home);

  const late = join(home, CONTROL_AFTER);
  mkdirSync(dirname(late), { recursive: true });
  writeFileSync(late, 'a tool the user added\n', 'utf8');

  const uninstall = runScript(script, home, ['uninstall']);
  const after = new Set(listTree(home));

  const expected = new Set([...before, CONTROL_AFTER, ...ancestorsOf(CONTROL_AFTER)]);

  return {
    install,
    uninstall,
    installedPaths: afterInstall.filter((path) => !before.includes(path)),
    residue: [...after].filter((path) => !expected.has(path)).sort(),
    destroyed: [...expected].filter((path) => !after.has(path)).sort(),
  };
}

/**
 * THE ONE INVARIANT, as a message or `null`.
 *
 * Every behavioural case below runs this same predicate, the correct script through it once and
 * each mutant through it once, which is the only shape that shows a gate can say no. The four
 * clauses are ordered so the first thing a red run reports is the first thing that went wrong.
 */
function cycleComplaint(report: CycleReport): string | null {
  if (report.install.status !== 0) {
    return `install exited ${String(report.install.status)}: ${report.install.stderr.trim()}`;
  }
  if (report.installedPaths.length === 0) {
    return 'the install put nothing in the home directory, so the uninstall had nothing to undo';
  }
  if (report.uninstall.status !== 0) {
    return `uninstall exited ${String(report.uninstall.status)}: ${report.uninstall.stderr.trim()}`;
  }
  if (report.destroyed.length > 0) {
    return `the uninstall destroyed path(s) this script did not install: ${report.destroyed.join(', ')}`;
  }
  if (report.residue.length > 0) {
    return `the uninstall left residue in the home directory: ${report.residue.join(', ')}`;
  }
  return null;
}

/** Apply a mutation to the script text and refuse to proceed if it matched nothing. */
function mutate(find: string, replace: string): string {
  const mutant = SCRIPT_SOURCE.replace(find, replace);
  expect(
    mutant,
    `the mutation "${find.slice(0, 60)}" matched nothing, so the case below would test a correct script`,
  ).not.toBe(SCRIPT_SOURCE);
  return mutant;
}

/* ------------------------------------------------------------------ *
 * PART 1 - the cases
 * ------------------------------------------------------------------ */

describe('scripts/install-local-bundle.sh: the text walk', () => {
  it('drops its prose, and the stripper is proven to have dropped some', () => {
    // NON-VACUITY FOR THE STRIPPER ITSELF. Every predicate in this half runs on the stripped
    // text, so a stripper that matched nothing would quietly widen all of them, and a stripper
    // that matched everything would quietly empty them.
    const stripped = stripProse(SCRIPT_SOURCE);
    expect(SCRIPT_SOURCE, 'the script no longer has a usage heredoc for the stripper to drop')
      .toContain("<<'USAGE'");
    expect(stripped, 'the prose stripper did not drop the usage heredoc body').not.toContain(
      'Unpacks the built Debian payload',
    );
    expect(stripped, 'the prose stripper did not drop the file header comment').not.toContain(
      'THE MOST DAMAGING MISTAKE AVAILABLE HERE',
    );
    expect(stripped, 'the prose stripper dropped the code as well as the prose').toContain(
      `${DECLARED_ARRAY}=(`,
    );
    expect(stripped, 'the prose stripper dropped the removal the whole file is about').toContain(
      `${REMOVAL_FUNCTION}()`,
    );
  });

  it('spells the home directory exactly one way in code, so the predicates can see every path', () => {
    expect(unseenHomeSpellings(SCRIPT_SOURCE)).toBeNull();
  });

  it('declares a destination for every part of the payload, named rather than counted', () => {
    const destinations = declaredDestinations(SCRIPT_SOURCE);
    for (const { name, match } of REQUIRED_DESTINATION_SHAPES) {
      expect(
        destinations.some((destination) => match.test(destination)),
        `no declared destination covers ${name}; the declared list is ${destinations.join(', ')}`,
      ).toBe(true);
    }
    for (const destination of destinations) {
      expect(destination.startsWith('$HOME/'), `${destination} is not under the user prefix`).toBe(
        true,
      );
    }
    // And the source half of every record is payload-relative, never absolute and never a
    // traversal, so `$payload/$(source_of ...)` cannot reach outside the unpacked payload.
    const sources = declaredSources(SCRIPT_SOURCE);
    expect(sources, 'the declared list parsed to no sources at all').not.toEqual([]);
    for (const source of sources) {
      expect(source.startsWith('usr/'), `${source} is not a payload-relative path`).toBe(true);
      expect(source, `${source} contains a parent traversal`).not.toContain('..');
    }
  });

  it('mentions no $HOME path outside the declared list', () => {
    expect(undeclaredHomePaths(SCRIPT_SOURCE)).toBeNull();
  });

  it('recursively removes no shared directory by name, the hicolor tree above all', () => {
    expect(destructiveRemovals(SCRIPT_SOURCE)).toBeNull();
  });

  it('contains exactly one rm, inside the one function that guards its operand', () => {
    // The structural answer to a variable operand. `removalsOutside` is null only when every
    // `rm` in the file sits inside `remove_path()`, and `remove_path()` is proven below to
    // refuse anything outside the user prefix before it removes it.
    expect(removalsOutside(SCRIPT_SOURCE, REMOVAL_FUNCTION)).toBeNull();

    const stripped = stripProse(SCRIPT_SOURCE);
    const sites = removalSites(stripped);
    expect(sites, 'the script contains no rm at all, so this case is vacuous').not.toEqual([]);

    const guard = functionSpan(stripped, REMOVAL_FUNCTION);
    expect(guard, `the script has no ${REMOVAL_FUNCTION}() function`).not.toBeNull();
    expect(
      guard?.body,
      `${REMOVAL_FUNCTION}() removes without first bounding its operand to the user prefix`,
    ).toContain('under_user_prefix');

    const prune = functionSpan(stripped, PRUNE_FUNCTION);
    expect(prune, `the script has no ${PRUNE_FUNCTION}() function`).not.toBeNull();
    expect(prune?.body, `${PRUNE_FUNCTION}() may only rmdir`).toContain('rmdir');
    expect(prune?.body, `${PRUNE_FUNCTION}() may only rmdir, and it now removes recursively`)
      .not.toMatch(/(?:^|[\s;&|(])rm\s/);
  });

  it('THE GATE CAN FAIL: a spliced-in recursive removal of the hicolor tree is rejected by name', () => {
    const mutant = mutate(
      'do_uninstall() {',
      'do_uninstall() {\n    rm -rf "$HOME/.local/share/icons/hicolor"',
    );
    expect(destructiveRemovals(mutant)).toContain('$HOME/.local/share/icons/hicolor');
    expect(removalsOutside(mutant, REMOVAL_FUNCTION)).toContain('rm -rf');
  });

  it('THE GATE CAN FAIL: the same removal spelled ${HOME} is rejected, where it used to pass', () => {
    // Review mutant A. The old predicates matched the literal `$HOME/` only, so this exact line
    // passed the whole file green. It is now rejected twice over: by the spelling ban, and by
    // the removal being outside the one function allowed to hold one.
    const mutant = mutate(
      'do_uninstall() {',
      'do_uninstall() {\n    rm -rf "${HOME}/.local/share/icons/hicolor"',
    );
    expect(unseenHomeSpellings(mutant)).toContain('${HOME}');
    expect(removalsOutside(mutant, REMOVAL_FUNCTION)).toContain('rm -rf');
  });

  it('THE GATE CAN FAIL: the same removal spelled ~/ is rejected, where it used to pass', () => {
    // Review mutant B, and the reason the usage heredoc had to become prose: the help text
    // legitimately writes `~/.local` for a human, so the ban is only writable once the walk
    // stops reading help text as code.
    const mutant = mutate(
      'do_uninstall() {',
      'do_uninstall() {\n    rm -rf ~/.local/share/icons/hicolor',
    );
    expect(unseenHomeSpellings(mutant)).toContain('~/');
    expect(removalsOutside(mutant, REMOVAL_FUNCTION)).toContain('rm -rf');
  });

  it('THE GATE CAN FAIL: a pruning walk switched from rmdir to rm -rf is rejected by name', () => {
    // Review mutant F, which passed the old gate green and would recursively delete another
    // application's icons out of a shared size bucket.
    const mutant = mutate('        if rmdir "$directory" 2>/dev/null; then', '        if rm -rf "$directory"; then');
    expect(removalsOutside(mutant, REMOVAL_FUNCTION)).toContain('rm -rf "$directory"');
  });

  it('THE GATE CAN FAIL: a spliced-in undeclared $HOME path is rejected by name', () => {
    const mutant = mutate(
      'do_install() {',
      'do_install() {\n    cp -a something "$HOME/.config/autostart/fabrico.desktop"',
    );
    expect(undeclaredHomePaths(mutant)).toContain('$HOME/.config/autostart/fabrico.desktop');
  });

  it('THE GATE CAN FAIL: a help-text edit is NOT a violation, because help text is not an operand', () => {
    // The inverse assertion, and it is the one that stops this file teaching an executor to
    // edit assertions. Under the first version of this gate, rewording the usage heredoc from
    // `~/.local` to `$HOME/.local` turned the suite RED - a documentation edit reddening a
    // safety gate is exactly how a reader learns the gate is noise.
    const mutant = mutate('Unpacks the built Debian payload into ~/.local', 'Unpacks the built Debian payload into $HOME/.local');
    expect(undeclaredHomePaths(mutant), 'a help-text edit is being read as a code path').toBeNull();
    expect(unseenHomeSpellings(mutant), 'a help-text edit is being read as a code path').toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * PART 2 - the cases that run the script
 * ------------------------------------------------------------------ */

describe('scripts/install-local-bundle.sh: the execution walk', () => {
  it('installs and then uninstalls back to exactly the tree it found', () => {
    const report = runCycle('clean', SCRIPT_SOURCE);

    // NON-VACUITY, before the invariant: the install has to have actually done something, or
    // "the uninstall left nothing behind" is true of a script that never ran.
    expect(
      report.installedPaths.filter((path) => path.endsWith('fabrico-app.png')).length,
      'no icon layer reached the home directory, so this cycle proves nothing',
    ).toBeGreaterThan(0);
    expect(cycleComplaint(report)).toBeNull();

    // And the file the user dropped into a directory OUR install created is still there.
    expect(report.destroyed, 'a file the user added beside ours was removed').toEqual([]);
    expect(report.uninstall.stdout, 'the uninstall reported nothing about the manifest').toContain(
      'removed',
    );
  });

  it('THE GATE CAN FAIL: an rm -rf of the shared icon tree in the uninstall is caught', () => {
    // Review mutant A, run for real this time. The old gate passed it green; here the two
    // planted icons and the theme index vanish and the invariant names them.
    const report = runCycle(
      'mutant-hicolor',
      mutate('do_uninstall() {', 'do_uninstall() {\n    rm -rf "${HOME}/.local/share/icons/hicolor"'),
    );
    const complaint = cycleComplaint(report);
    expect(complaint, 'an rm -rf of the shared icon tree completed a clean cycle').not.toBeNull();
    expect(complaint).toContain('destroyed');
    expect(complaint).toContain(CONTROLS_BEFORE[0]);
  });

  it('THE GATE CAN FAIL: an uninstall that removes nothing is caught', () => {
    // Review mutant D. The old gate's "removal set equals creation set" case could not tell
    // this from a correct uninstall, because both function bodies still mentioned the array.
    const report = runCycle(
      'mutant-removes-nothing',
      mutate(
        '        remove_path "$path"\n        printf \'removed  %s\\n\' "$path"',
        '        printf \'removed  %s\\n\' "$path"',
      ),
    );
    const complaint = cycleComplaint(report);
    expect(complaint, 'an uninstall that removes nothing completed a clean cycle').not.toBeNull();
    expect(complaint).toMatch(/residue|exited/);
  });

  it('THE GATE CAN FAIL: an uninstall that silently skips the icon record is caught', () => {
    // Review mutant E, and the regression this plan actually hit during execution. It was
    // found then by a manual `ls`, not by this gate.
    const report = runCycle(
      'mutant-skips-icons',
      mutate(
        '    for path in ${owned[@]+"${owned[@]}"}; do',
        '    for path in ${owned[@]+"${owned[@]}"}; do\n        case "$path" in *icons*) continue ;; esac',
      ),
    );
    const complaint = cycleComplaint(report);
    expect(complaint, 'an uninstall that skips every icon completed a clean cycle').not.toBeNull();
    expect(complaint).toMatch(/residue|exited/);
  });

  it('THE GATE CAN FAIL: a pruning walk switched to rm -rf destroys a file the user added', () => {
    // Review mutant F, run for real. `~/.local/bin` is a directory the install created, so the
    // prune owns it - but the user's own tool is inside it by then, and `rmdir` is what refuses.
    const report = runCycle(
      'mutant-prune-rm',
      mutate('        if rmdir "$directory" 2>/dev/null; then', '        if rm -rf "$directory"; then'),
    );
    const complaint = cycleComplaint(report);
    expect(complaint, 'a recursive prune completed a clean cycle').not.toBeNull();
    expect(complaint).toContain(CONTROL_AFTER);
  });

  it('refuses to remove a path it cannot show it created, and leaves it in place', () => {
    // CR-02, measured. With no manifest, a developer's own build at the declared binary path
    // and a populated resource directory used to be deleted, `rm -rf` for the directory.
    const home = freshHome('unowned');
    const planted = ['.local/bin/fabrico-app', '.local/lib/Fabrico/precious.txt'];
    for (const relative of planted) {
      const target = join(home, relative);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `mine, not yours: ${relative}\n`, 'utf8');
    }
    const before = listTree(home);

    const run = runScript(SCRIPT_PATH, home, ['uninstall']);

    expect(run.status, 'the uninstall claimed success over paths it did not install').toBe(1);
    expect(run.stdout, 'the uninstall did not name the path it left').toContain(
      '.local/bin/fabrico-app',
    );
    expect(run.stdout, 'the uninstall did not name the directory it left').toContain(
      '.local/lib/Fabrico',
    );
    expect(listTree(home), 'the uninstall removed a path it did not install').toEqual(before);
    for (const relative of planted) {
      expect(
        readFileSync(join(home, relative), 'utf8'),
        `${relative} was rewritten by an uninstall that did not create it`,
      ).toContain('mine, not yours');
    }
  });

  it('is idempotent: a second uninstall is a clean no-op', () => {
    const home = freshHome('idempotent');
    const payload = freshPayload('idempotent');

    expect(runScript(SCRIPT_PATH, home, ['install', '--payload', payload]).status).toBe(0);
    expect(runScript(SCRIPT_PATH, home, ['uninstall']).status).toBe(0);
    const settled = listTree(home);

    const second = runScript(SCRIPT_PATH, home, ['uninstall']);
    expect(second.status, 'a second uninstall did not exit cleanly').toBe(0);
    expect(second.stdout).toContain('nothing to remove');
    expect(listTree(home), 'a second uninstall changed the tree').toEqual(settled);
  });

  it('fails naming the record when the payload carries no icons at all', () => {
    // WR-01. `nullglob` made a source glob that matched nothing contribute zero iterations in
    // silence, so this payload used to install three files and print a success line - which is
    // the one failure mode that puts a generic executable icon in front of an approval walk.
    const home = freshHome('no-icons');
    const payload = freshPayload(
      'no-icons',
      PAYLOAD_FIXTURE.filter((path) => !path.includes('/icons/')),
    );

    const run = runScript(SCRIPT_PATH, home, ['install', '--payload', payload]);
    expect(run.status, 'an install with no icons reported success').toBe(2);
    expect(run.stderr).toContain('icons/hicolor');
    expect(listTree(home), 'the refused install still wrote into the home directory').toEqual([]);
  });

  it('THE GATE CAN FAIL: without the per-record check that payload installs silently', () => {
    // The mutation that proves the case above discriminates. Removing the per-record floor
    // restores the measured pre-fix behaviour: three files copied, exit 0, no icons.
    const home = freshHome('no-icons-mutant');
    const payload = freshPayload(
      'no-icons-mutant',
      PAYLOAD_FIXTURE.filter((path) => !path.includes('/icons/')),
    );
    const script = scriptCopy(
      'no-icons-mutant',
      mutate('        if [ "$matched" -eq 0 ]; then', '        if [ "$matched" -lt 0 ]; then'),
    );

    const run = runScript(script, home, ['install', '--payload', payload]);
    expect(run.status, 'the mutation did not restore the silent no-op, so the case above is not discriminating').toBe(0);
    expect(
      listTree(home).some((path) => path.endsWith('.png')),
      'the mutant installed icons, so the fixture was not actually icon-free',
    ).toBe(false);
  });

  it('keeps its overwrite guard on a home directory containing a space', () => {
    // WR-02. `for existing in $destination` left the destination unquoted for globbing, which
    // also enabled word splitting: `/tmp/ho me/.local/bin/fabrico-app` split into two paths
    // that exist nowhere, the guard found nothing, and the install overwrote the file it was
    // written to protect. Measured on the pre-fix script: exit 0, contents replaced.
    const spaced = join(freshHome('spaced'), 'ho me');
    mkdirSync(join(spaced, '.local', 'bin'), { recursive: true });
    writeFileSync(join(spaced, '.local', 'bin', 'fabrico-app'), 'PRE-EXISTING\n', 'utf8');
    const payload = freshPayload('spaced');

    const run = runScript(SCRIPT_PATH, spaced, ['install', '--payload', payload]);
    expect(run.status, 'the overwrite guard did not fire on a home containing a space').toBe(1);
    expect(run.stderr).toContain('already exists');
    expect(
      readFileSync(join(spaced, '.local', 'bin', 'fabrico-app'), 'utf8'),
      'the pre-existing file was overwritten',
    ).toBe('PRE-EXISTING\n');
  });

  it('refuses a second subcommand and a --payload with no value, rather than exiting silently', () => {
    // WR-10. `--payload` as the final argument shifted past the end and let `set -e` kill the
    // script with no output at all; a second subcommand silently won, so `verify uninstall`
    // ran the destructive one.
    const home = freshHome('arguments');

    const missing = runScript(SCRIPT_PATH, home, ['install', '--payload']);
    expect(missing.status).toBe(2);
    expect(missing.stderr, 'a --payload with no value exited silently').toContain('--payload needs');

    const twice = runScript(SCRIPT_PATH, home, ['verify', 'uninstall']);
    expect(twice.status).toBe(2);
    expect(twice.stderr, 'a second subcommand won silently').toContain('two subcommands');
  });

  it('refuses to run at all when HOME is empty', () => {
    // The one input that would make every declared destination root-relative. `set -u` already
    // catches an UNSET HOME; an empty one is a different value and used to pass straight through.
    const result = spawnSync('bash', [SCRIPT_PATH, 'uninstall'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: '' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('HOME is empty');
  });
});
