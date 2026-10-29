// fontNotice.test.ts - every embedded font and its OFL licence text match the pins in NOTICE.md
// (LIC-06, Phase 80 IN-04; Sono added 2026-10-11).
//
// WHY THIS FILE EXISTS. NOTICE.md says of each licence text: "the sha256 and the size above are
// what a substituted copy would change". Until 2026-10-11 nothing read those two numbers. The
// font BINARY's sha was asserted (`render/assets/lockup.test.ts` and `build-lockup.ts`), the
// licence text only by length and first line, so editing the body of OFL-1.1-MartianMono.txt
// reddened nothing (re-verification mutation m18, `reverify-2026-10-11/phase-80.md`). Sono, also
// embedded in every binary, had no test on either file.
//
// THE PINS ARE READ OUT OF NOTICE.md, NOT REPEATED HERE. A hex literal in this spec would only
// make the spec agree with itself; the property worth holding is that the notice a user reads and
// the bytes that ship agree. Both directions are covered: change a file and its hash moves away
// from the notice; change the notice and the notice moves away from the file.
//
// WHAT WOULD MAKE THIS VACUOUS, and the guard for each:
//   1. A NOTICE.md reflow that stops a regex matching, so a face is skipped. Every regex miss
//      throws by name; nothing is optional.
//   2. A face that ships without a section at all. The set of `*.woff2` files on disk must equal
//      the set of `## *.woff2` sections, and both must contain the named floor below.
//   3. A licence row that points at the wrong file. The licence's copyright holder must be the
//      holder NOTICE.md quotes as embedded in that face's binary.
//
// No `@vitest-environment` docblock: the node default is what lets this read disk through
// `import.meta.url`.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FONTS_DIR = fileURLToPath(new URL('./', import.meta.url));
const NOTICE = readFileSync(new URL('./NOTICE.md', import.meta.url), 'utf8');

/** The faces that must be documented. A named floor, so losing one reddens by name. */
const FLOOR_FACES = ['MartianMono.woff2', 'Sono.woff2'] as const;

interface FacePins {
  face: string;
  fontSha: string;
  fontBytes: number;
  licenceFile: string;
  licenceSha: string;
  licenceBytes: number;
  holder: string;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const count = (digits: string): number => Number(digits.replace(/,/g, ''));

/** Every `## <name>.woff2` section of NOTICE.md, keyed by face file name. */
function sections(notice: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of notice.split(/^## /m).slice(1)) {
    const name = block.slice(0, block.indexOf('\n')).trim();
    if (name.endsWith('.woff2')) out.set(name, block);
  }
  return out;
}

/** Parse one face's pins out of its section. Throws by name on any miss rather than skipping. */
function readPins(face: string, block: string): FacePins {
  const need = (re: RegExp, what: string): RegExpExecArray => {
    const m = re.exec(block);
    if (m === null) throw new Error(`NOTICE.md section ${face} carries no ${what}`);
    return m;
  };
  const sha = need(/- \*\*SHA-256:\*\* ([0-9a-f]{64})/, 'font SHA-256 line');
  const size = need(/- \*\*Size:\*\* ([\d,]+) bytes\./, 'font Size line');
  const lic = need(
    /- \*\*License text:\*\* (\S+) in this directory[\s\S]*?sha256\s+([0-9a-f]{64}), ([\d,]+) bytes\)/,
    'License text line with sha256 and size',
  );
  const holder = need(
    /- \*\*Copyright notice, as embedded in the binary:\*\* Copyright \d{4} ([\s\S]+?) \(/,
    'embedded copyright notice',
  );
  return {
    face,
    fontSha: sha[1]!,
    fontBytes: count(size[1]!),
    licenceFile: lic[1]!,
    licenceSha: lic[2]!,
    licenceBytes: count(lic[3]!),
    // The notice wraps at the column limit, so a holder can span a line break.
    holder: holder[1]!.replace(/\s+/g, ' '),
  };
}

/**
 * `null` when the licence bytes match the pins, otherwise a message naming what moved.
 * Module level so the mutation case can hand it a broken copy and watch it say no.
 */
function licenceFault(pins: FacePins, bytes: Buffer): string | null {
  const got = sha256(bytes);
  if (got !== pins.licenceSha) {
    return `${pins.licenceFile} hashes ${got}, NOTICE.md pins ${pins.licenceSha}`;
  }
  if (bytes.length !== pins.licenceBytes) {
    return `${pins.licenceFile} is ${String(bytes.length)} bytes, NOTICE.md pins ${String(pins.licenceBytes)}`;
  }
  return null;
}

const SECTIONS = sections(NOTICE);

/** One face's pins, parsed inside the case that needs them so a miss reddens that case by name. */
function pinsOf(face: string): FacePins {
  const block = SECTIONS.get(face);
  if (block === undefined) throw new Error(`NOTICE.md has no ## ${face} section`);
  return readPins(face, block);
}

describe('NOTICE.md documents every embedded font (LIC-06)', () => {
  it('has a section for every woff2 on disk and no section for a face that is not there', () => {
    const onDisk = readdirSync(FONTS_DIR).filter((f) => f.endsWith('.woff2')).sort();
    const documented = [...SECTIONS.keys()].sort();
    for (const face of FLOOR_FACES) {
      expect(onDisk, `${face} is missing from ${FONTS_DIR}`).toContain(face);
    }
    expect(documented, 'the NOTICE.md sections and the woff2 files on disk differ').toEqual(onDisk);
  });

  for (const face of FLOOR_FACES) {
    describe(face, () => {
      const pins = (): FacePins => pinsOf(face);

      it('the font binary matches the NOTICE.md SHA-256 and size', () => {
        const p = pins();
        const bytes = readFileSync(new URL(`./${face}`, import.meta.url));
        expect(sha256(bytes), `${face} sha256 against NOTICE.md`).toBe(p.fontSha);
        expect(bytes.length, `${face} size against NOTICE.md`).toBe(p.fontBytes);
      });

      it('the OFL licence text matches the NOTICE.md sha256 and size', () => {
        const p = pins();
        const bytes = readFileSync(new URL(`./${p.licenceFile}`, import.meta.url));
        const fault = licenceFault(p, bytes);
        // The fault text is the message, so a red run reads in full rather than truncated.
        expect(fault, fault ?? 'licence text matches NOTICE.md').toBeNull();
      });

      it('the licence names the copyright holder NOTICE.md quotes from the binary', () => {
        const p = pins();
        const text = readFileSync(new URL(`./${p.licenceFile}`, import.meta.url), 'utf8');
        const first = text.split('\n').find((line) => line.trim().length > 0) ?? '';
        expect(first, `${p.licenceFile} first line`).toMatch(/^Copyright \d{4} /);
        expect(first, `${p.licenceFile} names a different holder than ${face}`).toContain(p.holder);
      });
    });
  }

  it('THE GATE CAN FAIL: a licence body with one word changed is rejected by name', () => {
    // The re-verification's m18, replayed in memory: nothing is written to disk.
    const p = pinsOf('MartianMono.woff2');
    const committed = readFileSync(new URL(`./${p.licenceFile}`, import.meta.url));
    const mutant = Buffer.from(
      committed.toString('utf8').replace('PERMISSION & CONDITIONS', 'PERMISSION AND CONDITIONS'),
      'utf8',
    );
    expect(mutant.equals(committed), 'the substitution matched nothing, so this case is vacuous').toBe(
      false,
    );
    expect(licenceFault(p, mutant)).toMatch(/OFL-1\.1-MartianMono\.txt hashes [0-9a-f]{64}, NOTICE\.md pins/);
    expect(licenceFault(p, committed)).toBeNull();
  });
});
