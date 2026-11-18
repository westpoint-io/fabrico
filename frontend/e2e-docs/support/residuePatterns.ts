import fs from 'node:fs';
import path from 'node:path';

// The residue gate's docs-site id patterns, read from scripts/check-no-private-residue.sh at run
// time, for the specs that scan built files: e2e-docs/leaks.spec.ts over the built site, and
// e2e-offline/offline.spec.ts over the offline examples file it opens (which can be a downloaded
// release copy). Reading the gate itself keeps the specs and the gate from drifting apart.
//
// No test is registered here.

const REPO = path.resolve(import.meta.dirname, '../../..');

/** The residue gate, whose SITE_PATTERNS array and SITE_ALLOWED_TOKENS line this file reads. */
export const RESIDUE_GATE = path.join(REPO, 'scripts/check-no-private-residue.sh');

/** The gate's site id patterns and the real tokens of an id's shape it allows. */
export interface SitePatterns {
  patterns: { label: string; pattern: RegExp }[];
  allowed: Set<string>;
}

/**
 * The residue gate's site/ id patterns, as `{ label, pattern }`, read from its SITE_PATTERNS array,
 * and its allowed tokens. Throws unless exactly four patterns and at least one token come out, so a
 * change to the gate's layout fails here loudly.
 *
 * The gate's ERE boundaries `(^|[^A-Za-z0-9])` and `([^A-Za-z0-9]|$)` become lookarounds here. As
 * written they take the character beside a match, so a global search would skip `GATE-07` right after
 * `UTF-16 ` (the space already taken), and the allowed token would hide the id beside it. The gate
 * reads whole lines with grep, which has no such gap.
 */
export function sitePatterns(): SitePatterns {
  const gate = fs.readFileSync(RESIDUE_GATE, 'utf8');
  const prefix = /^REQ_PREFIX='([^']+)'$/m.exec(gate);
  const tokens = /^SITE_ALLOWED_TOKENS='([^']*)'$/m.exec(gate);
  const block = /^SITE_PATTERNS=\(\n([\s\S]*?)\n\)$/m.exec(gate);
  if (prefix === null || tokens === null || block === null) {
    throw new Error(`${RESIDUE_GATE} has no REQ_PREFIX line, SITE_ALLOWED_TOKENS line or SITE_PATTERNS array to read`);
  }
  const patterns = block[1]
    .split('\n')
    .map((line) => /^\s*"([^\t"]+)\t([-i])\t(.+)"$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      label: m[1],
      pattern: new RegExp(
        m[3]
          .replaceAll('${REQ_PREFIX}', prefix[1])
          .replaceAll('(^|[^A-Za-z0-9])', '(?<![A-Za-z0-9])')
          .replaceAll('([^A-Za-z0-9]|$)', '(?![A-Za-z0-9])'),
        m[2] === 'i' ? 'gim' : 'gm',
      ),
    }));
  if (patterns.length !== 4) {
    throw new Error(`read ${patterns.length} site/ patterns from ${RESIDUE_GATE}, expected 4`);
  }
  const allowed = new Set(tokens[1].split(/\s+/).filter((t) => t !== ''));
  if (allowed.size === 0) throw new Error(`read no allowed token from ${RESIDUE_GATE}`);
  return { patterns, allowed };
}

/**
 * True when a match is an allowed token standing alone, with no letter, digit or hyphen on either
 * side: the gate's rule, which excuses a whole run of letters, digits and hyphens and nothing else.
 */
export function isAllowedToken(text: string, index: number, token: string, allowed: Set<string>): boolean {
  if (!allowed.has(token)) return false;
  const before = index === 0 ? '' : text[index - 1];
  const after = text[index + token.length] ?? '';
  return !/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after);
}

/** Every planning id the site patterns find in `text`, as one line per match naming `shown`. */
export function idsIn(shown: string, text: string, ids: SitePatterns): string[] {
  const out: string[] = [];
  for (const { label, pattern } of ids.patterns) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (isAllowedToken(text, m.index, m[0], ids.allowed)) continue;
      out.push(`${shown}: ${label}: "${m[0].trim()}"`);
    }
  }
  return out;
}
