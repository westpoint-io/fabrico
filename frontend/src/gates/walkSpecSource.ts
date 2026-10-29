// walkSpecSource.ts - the text parser the two walk-spec source gates share.
//
// Users: `liveWalkDeclarationOrder.source.test.ts` (the v8.0 walk, spec 24) and
// `oneBoardAllFive.source.test.ts` (the v9.0 composed walk, spec 77). Both read a live spec
// AS TEXT on every `npm test`; neither imports it or runs Playwright.
//
// `stripComments`, `Declaration` and `declarations` were EXTRACTED VERBATIM from the v8 gate by
// plan 77-01, so the two gates read the same declarations the same way. They live in a non-test
// module because a `.test.ts` file is not something another test should import. The helpers
// below them (`declarationBodies`, `functionBody`, `tokensInsideAssertions`) were added by the
// same plan for the composed walk's rules, `assertionArguments`, `assertionsCarrying` and
// `blankStrings` by its refuter round, and `assertionMatcher` by the 77-02 refuter round.
//
// WHAT THE PARSER CANNOT SEE is said in the v8 gate's header and holds for every helper here: a
// declaration made through an alias, a helper or a loop; a regex literal carrying an unbalanced
// quote or a comment opener; a template literal whose `${...}` nests another backtick string.
// The house style of both walk specs avoids all three, and each gate's "strips to something
// still recognisable" case is the tripwire for the stripper going wrong.

/**
 * Blank out comments, PRESERVING every newline so line numbers survive.
 *
 * A character scanner rather than a regex, because the spec's copy contains apostrophes
 * and slashes and a regex sweep over `/* ... *\/` can be opened by either.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const keepNewlines = (text: string): string => text.replace(/[^\n]/g, ' ');

  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += keepNewlines(src.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i];
        if (c === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === ch) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export interface Declaration {
  /** 1-based line in the original file. */
  line: number;
  /** Character offset of the declaration in the stripped source. */
  index: number;
  /** `null` for the bare `test(` form, otherwise the Playwright modifier used. */
  modifier: string | null;
  title: string;
}

/**
 * Every `test(` declaration, in file order.
 *
 * Line-leading after optional indentation, and the four Playwright modifier forms are
 * matched too. WR-07 widened the plan's original grep for that second half: it saw the
 * bare form only, so a `test.fixme(` appended at the end was invisible to the very guard
 * meant to catch it. `test.describe(` is deliberately not a match; it groups, it does not
 * declare a runnable.
 */
export function declarations(stripped: string): Declaration[] {
  const pattern = /^[ \t]*test(?:\.(only|skip|fixme|fail))?[ \t]*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/gm;
  const found: Declaration[] = [];
  for (const m of stripped.matchAll(pattern)) {
    found.push({
      index: m.index,
      line: stripped.slice(0, m.index).split('\n').length,
      modifier: m[1] ?? null,
      title: m[3],
    });
  }
  return found;
}

/** One declaration and the stripped text that belongs to it. */
export interface DeclarationBody {
  declaration: Declaration;
  /** Offset of the body's first character in the stripped source (the declaration's own). */
  start: number;
  /** Offset one past the body's last character. */
  end: number;
  /** `stripped.slice(start, end)`. */
  text: string;
}

/**
 * Each declaration's text, from its own line up to the next declaration, or the next
 * `test.afterAll(` after it, or the end of the file, whichever comes first.
 */
export function declarationBodies(stripped: string): DeclarationBody[] {
  const decls = declarations(stripped);
  const afterAlls = [...stripped.matchAll(/^[ \t]*test\.afterAll[ \t]*\(/gm)].map((m) => m.index);
  return decls.map((declaration, i) => {
    const start = declaration.index;
    const candidates = [stripped.length];
    if (i + 1 < decls.length) candidates.push(decls[i + 1].index);
    for (const a of afterAlls) if (a > start) candidates.push(a);
    const end = Math.min(...candidates);
    return { declaration, start, end, text: stripped.slice(start, end) };
  });
}

/** A span of the stripped source: where it starts, where it ends, and its text. */
export interface SourceSpan {
  start: number;
  end: number;
  text: string;
}

/**
 * The text of the top-level `async function <name>(` (or plain `function <name>(`), from its
 * keyword to its closing brace at column 0, cut short at the next top-level function,
 * `test.describe`, `test.afterAll` or test declaration if one comes first. `null` when no such
 * function is declared.
 */
export function functionBody(stripped: string, name: string): SourceSpan | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^(?:export[ \\t]+)?(?:async[ \\t]+)?function[ \\t]+${escaped}[ \\t]*[(<]`, 'm');
  const m = head.exec(stripped);
  if (m === null) return null;
  const start = m.index;
  const rest = stripped.slice(start + 1);
  const next =
    /^(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]|^test\.describe\b|^test\.afterAll\b|^[ \t]*test(?:\.(?:only|skip|fixme|fail))?[ \t]*\(/m.exec(
      rest,
    );
  const close = /^\}/m.exec(rest);
  const candidates = [stripped.length];
  if (next !== null) candidates.push(start + 1 + next.index);
  if (close !== null) candidates.push(start + 1 + close.index + 1);
  const end = Math.min(...candidates);
  return { start, end, text: stripped.slice(start, end) };
}

/** The callees whose argument list counts as an assertion for `tokensInsideAssertions`. */
export const ASSERTION_CALLEES = [
  'expect',
  'expect.poll',
  'expect.soft',
  'pollScene',
  'expectRunningUnaided',
  'expectRefusalStayedSilent',
  'expectHeadOn',
] as const;

/**
 * Which of `tokens` lie INSIDE the parentheses of an assertion call in `body`: `expect(`,
 * `expect.poll(`, `expect.soft(`, `pollScene(`, `expectRunningUnaided(`,
 * `expectRefusalStayedSilent(` or `expectHeadOn(` (the last three take a context string that
 * becomes their failure message; `expectHeadOn` joined them in the 77-05 refuter round, when
 * deleting leg 5's head-on loop left the composed walk's gate green). The closing parenthesis
 * is found by a balanced scan that skips the contents of string literals, so a parenthesis
 * inside a message does not end the call early. A token
 * found only in a comment, a log line or a bare string is NOT returned. Pass the
 * comment-stripped body.
 */
export function tokensInsideAssertions(body: string, tokens: readonly string[]): string[] {
  const counts = assertionsCarrying(body, tokens);
  return tokens.filter((t) => counts[t] > 0);
}

/** The text INSIDE the parentheses of every assertion call in `body`, in source order (the same
 *  callees and the same balanced scan as `tokensInsideAssertions`). */
export function assertionArguments(body: string): SourceSpan[] {
  // `expect\n    .poll(` is the house style for a long poll, so whitespace may sit around the dot.
  const opener =
    /(?<![\w.$])(?:expect(?:\s*\.\s*(?:poll|soft))?|pollScene|expectRunningUnaided|expectRefusalStayedSilent|expectHeadOn)\s*\(/g;
  const out: SourceSpan[] = [];
  for (const m of body.matchAll(opener)) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(body, open);
    const end = close === -1 ? body.length : close;
    out.push({ start: open + 1, end, text: body.slice(open + 1, end) });
  }
  return out;
}

/**
 * For each token, HOW MANY assertion calls in `body` carry it inside their parentheses (added by
 * the 77-01 refuter round). A token several assertions share is held by its count, so deleting
 * any ONE of them changes the count; a bare presence test is green while one copy survives.
 */
export function assertionsCarrying(body: string, tokens: readonly string[]): Record<string, number> {
  const args = assertionArguments(body);
  const out: Record<string, number> = {};
  for (const t of tokens) out[t] = args.filter((a) => a.text.includes(t)).length;
  return out;
}

/**
 * The matcher an assertion call ends in (the 77-02 refuter round): for the call whose argument
 * list is `args` in `body`, the `.matcher(` that follows its closing parenthesis, whether a
 * `.not` sits before it, and the matcher's own argument text. `null` when no matcher follows,
 * which is the shape of the `expectRunningUnaided(` and `expectRefusalStayedSilent(` helpers:
 * they assert inside and return nothing to match.
 */
export function assertionMatcher(
  body: string,
  args: SourceSpan,
): { name: string; negated: boolean; argument: string } | null {
  const after = body.slice(args.end + 1);
  const m = /^\s*((?:\.\s*(?:not|resolves|rejects)\s*)*)\.\s*(to\w+)\s*\(/.exec(after);
  if (m === null) return null;
  const open = args.end + 1 + m[0].length - 1;
  const close = matchingParen(body, open);
  return {
    name: m[2],
    negated: /\bnot\b/.test(m[1]),
    argument: body.slice(open + 1, close === -1 ? body.length : close),
  };
}

/**
 * Blank the CONTENTS of every string literal, preserving its quotes, every newline and every
 * offset, so an identifier scan cannot match a word inside a message. A template literal's
 * `${...}` code is kept, because code can run there. Pass the comment-stripped source.
 */
export function blankStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      out += ch;
      i += 1;
      while (i < src.length && src[i] !== ch) {
        if (ch === '`' && src[i] === '$' && src[i + 1] === '{') {
          const close = matchingBrace(src, i + 1);
          const stop = close === -1 ? src.length : close + 1;
          out += src.slice(i, stop);
          i = stop;
          continue;
        }
        const step = src[i] === '\\' ? 2 : 1;
        out += src.slice(i, i + step).replace(/[^\n]/g, ' ');
        i += step;
      }
      if (i < src.length) out += src[i];
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** The index of the `}` that closes the `{` at `open`, skipping string literal contents. */
function matchingBrace(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * The index of the `)` that closes the `(` at `open`, skipping string literal contents, or
 * -1 when it is never closed.
 */
export function matchingParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}
