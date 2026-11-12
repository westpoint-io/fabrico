// request.test.ts - the request line's word, the only URL shape the card takes, and the line itself.

import { describe, expect, it } from 'vitest';
import { ROUTE_URL_SHAPE, acceptRouteUrl, curlWordFor, requestLineText } from './request.ts';

const WINDOWS_CHROMIUM = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WEBVIEW2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const LINUX_CHROMIUM = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const GOOD = 'http://127.0.0.1:54321/endpoint/route-1';

describe('curlWordFor', () => {
  it('gives curl.exe for a Windows 10 Chromium user agent', () => {
    expect(curlWordFor(WINDOWS_CHROMIUM)).toBe('curl.exe');
  });

  it('gives curl.exe for a WebView2 user agent, the one the Windows app runs in', () => {
    expect(curlWordFor(WEBVIEW2)).toBe('curl.exe');
  });

  it('gives curl for Linux Chromium, macOS Safari and the empty string', () => {
    expect([LINUX_CHROMIUM, MAC_SAFARI, ''].map(curlWordFor)).toEqual(['curl', 'curl', 'curl']);
  });
});

describe('acceptRouteUrl', () => {
  it('returns a good URL as it is', () => {
    expect(acceptRouteUrl(GOOD)).toBe(GOOD);
    expect(acceptRouteUrl('http://127.0.0.1:65535/endpoint/orders/new_v2.1~x')).toBe('http://127.0.0.1:65535/endpoint/orders/new_v2.1~x');
  });

  it("refuses the row's Webhook not ready words", () => {
    expect(acceptRouteUrl('Webhook not ready')).toBeNull();
  });

  it('refuses a port 0 URL, which a failed bind leaves', () => {
    expect(acceptRouteUrl('http://127.0.0.1:0/endpoint/route-1')).toBeNull();
  });

  it('refuses a path holding a space or a semicolon', () => {
    expect(acceptRouteUrl('http://127.0.0.1:54321/endpoint/route 1')).toBeNull();
    expect(acceptRouteUrl('http://127.0.0.1:54321/endpoint/route;rm')).toBeNull();
  });

  it('refuses an https URL', () => {
    expect(acceptRouteUrl('https://127.0.0.1:54321/endpoint/route-1')).toBeNull();
  });

  it('refuses markup, quotes, a port above 65535, an empty path, another host and no text at all', () => {
    for (const text of [
      'http://127.0.0.1:54321/endpoint/<b>x</b>',
      "http://127.0.0.1:54321/endpoint/a'b",
      'http://127.0.0.1:54321/endpoint/$(id)',
      'http://127.0.0.1:65536/endpoint/route-1',
      'http://127.0.0.1:54321/endpoint/',
      'http://localhost:54321/endpoint/route-1',
      `${GOOD}\n`,
      '',
      null,
      undefined,
    ]) {
      expect(acceptRouteUrl(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('anchors the shape at both ends', () => {
    expect(ROUTE_URL_SHAPE.source.startsWith('^')).toBe(true);
    expect(ROUTE_URL_SHAPE.source.endsWith('$')).toBe(true);
    expect(ROUTE_URL_SHAPE.flags).toBe('');
  });
});

describe('requestLineText', () => {
  it('is the word, -X POST, then the URL', () => {
    expect(requestLineText('curl.exe', GOOD)).toBe(`curl.exe -X POST ${GOOD}`);
    expect(requestLineText('curl', GOOD)).toBe(`curl -X POST ${GOOD}`);
  });
});
