// request.ts - the request line the step card shows under a lesson's instruction.
//
// Pure, like the rest of this folder: the user agent and the URL are parameters, and nothing here names a
// browser global. The layer reads the URL off the inspector's POST URL row and the user agent off the
// browser, and passes both in.

/** The word a user types for curl: `curl.exe` on Windows, where PowerShell aliases `curl` to another command. */
export type CurlWord = 'curl' | 'curl.exe';

/** `curl.exe` when the user agent names Windows (Chromium, Edge and WebView2 all say `Windows NT`), `curl` everywhere else, the empty string included. */
export function curlWordFor(userAgent: string): CurlWord {
  return /\bWindows\b/.test(userAgent) ? 'curl.exe' : 'curl';
}

/**
 * The only URL the card takes: the host's loopback endpoint on a real port (a failed bind leaves port 0),
 * then a path of the bytes a typed Route path allows. A space, a quote, a semicolon or any other byte a
 * shell acts on is refused, because the user pastes the line into a shell unquoted, and so are the
 * row's "Webhook not ready" words.
 */
export const ROUTE_URL_SHAPE = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/endpoint\/[A-Za-z0-9._~/-]+$/;

/** The highest TCP port. The shape allows five digits, so a port above this is refused here. */
const MAX_PORT = 65535;

/** The text when it is a URL the card can show, else null. */
export function acceptRouteUrl(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !ROUTE_URL_SHAPE.test(text)) return null;
  const port = Number(text.slice('http://127.0.0.1:'.length, text.indexOf('/', 'http://127.0.0.1:'.length)));
  return port <= MAX_PORT ? text : null;
}

/** The line the user runs: `<word> -X POST <url>`, no body and no headers. */
export function requestLineText(word: string, url: string): string {
  return `${word} -X POST ${url}`;
}
