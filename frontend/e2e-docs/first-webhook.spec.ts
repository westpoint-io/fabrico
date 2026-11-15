import { expect, test } from '@playwright/test';
import { readFirstWebhookCurl } from '../e2e-live/support/pageCurl.ts';

// The curl command on Send your first webhook, read with the same parser the first-webhook live
// spec runs before it sends the command to the real app. A push that changes only the docs site
// runs this suite and not the live one, so this is the check that catches a broken command on such
// a push: a second curl block, a changed URL or path, a missing header, or a body that isn't JSON.

test('Send your first webhook: the page holds one curl block in the form the live spec runs', () => {
  const curl = readFirstWebhookCurl();
  expect(curl.deliveryId, 'the command sends the delivery id the page tells the reader to change').toBe('first-1');
  expect(() => JSON.parse(curl.body), 'the body is JSON').not.toThrow();
  expect(curl.urlFor(8080, 7), 'PORT and ID fill in as a loopback /hook/src- URL').toBe('http://127.0.0.1:8080/hook/src-7');
});
