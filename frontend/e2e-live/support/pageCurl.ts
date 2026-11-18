// pageCurl.ts - the one reader of the curl commands the docs teach: the "Send your first webhook"
// page (`site/src/content/docs/get-started/first-webhook.mdx`), the "Reproduce a bug" page
// (`site/src/content/docs/patterns/reproduce-a-bug.mdx`) and the repository README (`README.md`).
//
// Three suites use it. The first-webhook and reproduce-a-bug live specs read their page at run
// time, take the delivery id and the body from the command, fill in the real port and Source id,
// and run the real curl binary against the live host. The docs suite runs the same parse on the
// first-webhook page and on the README (`e2e-docs/readme.spec.ts`), so a push that changes only
// the docs site or the README still fails if it breaks the command (the docs job runs on such a
// push and the live job doesn't).
//
// A block counts as the command when its first non-empty line starts with `curl `. The README's
// install block names the `curl` package on its apt line, so the word alone can't pick the block.
//
// THE PAGE TEXT NEVER REACHES A SHELL. The block is matched whole against one fixed form; what
// comes back is a delivery id made of plain characters and a body that parsed as JSON. The caller
// hands curl an argument array (`curlArgs`) through `execFileSync`, never a command string.
//
// No import from the rest of the live support, so the docs suite can load this file alone.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The page the command lives on. */
export const FIRST_WEBHOOK_PAGE = fileURLToPath(
  new URL('../../../site/src/content/docs/get-started/first-webhook.mdx', import.meta.url),
);

/** The repository README, whose quickstart ends with the same form of curl command. */
export const README_PATH = fileURLToPath(new URL('../../../README.md', import.meta.url));

/** The URL the block must POST to, with the two words the reader replaces. */
export const URL_TEMPLATE = 'http://127.0.0.1:PORT/hook/src-ID';

/** What the page's command sends, once the reader fills in the port and the Source id. */
export interface PageCurl {
  /** The `x-delivery-id` header's value as the page writes it (`first-1`). */
  deliveryId: string;
  /** The `-d` body, exactly as written between the quotes. It parsed as JSON. */
  body: string;
  /** The block's URL with PORT and ID filled in. */
  urlFor(port: number, id: number): string;
}

/** One fenced code block: its language word, its lines and the line its opening fence is on. */
export interface Fence {
  lang: string;
  lines: string[];
  startLine: number;
}

/** Every fenced code block in a Markdown or MDX file, in file order. */
export function fencesOf(mdx: string): Fence[] {
  const out: Fence[] = [];
  const lines = mdx.split('\n');
  let open: Fence | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (open === null) {
      const m = /^\s*```(\S*)/.exec(line);
      if (m) open = { lang: m[1], lines: [], startLine: i + 1 };
    } else if (/^\s*```\s*$/.test(line)) {
      out.push(open);
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  if (open !== null) throw new Error(`pageCurl: the code block opened on line ${open.startLine} never closes`);
  return out;
}

/** The fenced `bash` blocks whose first non-empty line starts with `curl `, in file order. */
export function curlBlocksOf(mdx: string): Fence[] {
  return fencesOf(mdx).filter((f) => f.lang === 'bash' && /^\s*curl /.test(f.lines.find((l) => l.trim() !== '') ?? ''));
}

/** A delivery id the live spec can send back unchanged: letters, digits, dot, dash, underscore. */
const DELIVERY_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Find the page's one fenced `bash` block whose first non-empty line starts with `curl `, check
 * it is the command the page teaches, and return what it sends. Throws a message naming what
 * didn't match: no block, more than one, a different start, the wrong URL or path, a missing or
 * repeated header, a header other than `x-delivery-id`, a missing or repeated body, a body that
 * isn't JSON, or anything left over after the body.
 */
export function parseFirstWebhookCurl(mdx: string): PageCurl {
  const blocks = curlBlocksOf(mdx);
  if (blocks.length === 0) throw new Error('pageCurl: the page has no fenced bash block that starts with curl');
  if (blocks.length > 1) {
    throw new Error(
      `pageCurl: the page has ${blocks.length} fenced bash blocks that start with curl (lines ${blocks.map((b) => b.startLine).join(', ')}), expected exactly 1`,
    );
  }
  // Join the line continuations: the spaces and backslash ending a line, then the next line's indent.
  const command = blocks[0].lines
    .join('\n')
    .replace(/[ \t]*\\\n\s*/g, ' ')
    .trim();
  if (command.includes('\n')) throw new Error(`pageCurl: the block holds more than one command:\n${command}`);

  const start = /^curl -X POST (\S+) /.exec(command);
  if (!start) throw new Error(`pageCurl: the command doesn't start "curl -X POST <url> ": ${command}`);
  if (start[1] !== URL_TEMPLATE) {
    throw new Error(`pageCurl: the command posts to ${start[1]}, expected ${URL_TEMPLATE}`);
  }
  const rest = command.slice(start[0].length);

  const headers = [...rest.matchAll(/-H '([^']*)'/g)];
  if (headers.length !== 1) throw new Error(`pageCurl: the command has ${headers.length} -H headers, expected 1: ${command}`);
  const header = /^x-delivery-id: (.+)$/.exec(headers[0][1]);
  if (!header) throw new Error(`pageCurl: the header is "${headers[0][1]}", expected "x-delivery-id: <id>"`);
  if (!DELIVERY_ID.test(header[1])) {
    throw new Error(`pageCurl: the delivery id "${header[1]}" has characters other than letters, digits, dot, dash and underscore`);
  }

  const bodies = [...rest.matchAll(/-d '([^']*)'/g)];
  if (bodies.length !== 1) throw new Error(`pageCurl: the command has ${bodies.length} -d bodies, expected 1: ${command}`);
  const body = bodies[0][1];
  try {
    JSON.parse(body);
  } catch (e) {
    throw new Error(`pageCurl: the body ${body} isn't JSON (${(e as Error).message})`);
  }

  // The whole command, in order, and nothing else: the header, then the body.
  if (rest !== `${headers[0][0]} ${bodies[0][0]}`) {
    throw new Error(`pageCurl: expected exactly "-H '<header>' -d '<body>'" after the URL, got: ${rest}`);
  }

  return {
    deliveryId: header[1],
    body,
    urlFor: (port: number, id: number) => URL_TEMPLATE.replace('PORT', String(port)).replace('ID', String(id)),
  };
}

/** Read the page from disk and parse its command. */
export function readFirstWebhookCurl(path: string = FIRST_WEBHOOK_PAGE): PageCurl {
  return parseFirstWebhookCurl(readFileSync(path, 'utf8'));
}

/**
 * The argument array for curl: POST the body to `url` with the delivery id, print only the
 * status code. For `execFileSync('curl', curlArgs(...))`, never a shell.
 */
export function curlArgs(url: string, deliveryId: string, body: string): string[] {
  return ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', url, '-H', 'x-delivery-id: ' + deliveryId, '-d', body];
}
