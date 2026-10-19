// Python e3a26821: quoted provider headers and multiline values in diagnostics.
import { expect, it } from 'vitest';
import { redactTextSecrets } from '../index.js';

it.each([
  "{'authorization': 'Bearer hdr-secret-1'}",
  '{"Authorization": "Bearer hdr-secret-1"}',
  '{"authorization": "Bearer hdr-secret-1"}',
  '{"api-key": "hdr-secret-1"}',
  "{'x-api-key': \"hdr-secret-1\"}",
  "{'X-Session-API-Key': 'hdr-secret-1'}",
  'Error: {\\"Authorization\\": \\"Bearer hdr-secret-1\\"}',
])('redacts the provider credential in %s', text => {
  expect(redactTextSecrets(text)).not.toContain('hdr-secret-1');
  expect(redactTextSecrets(text)).toContain('<redacted>');
});

it.each([
  ['private_key', "'", "'"], ['token', '"', '"'], ['authorization', "'", '"'], ['password', '\\"', '\\"'],
])('redacts multiline %s without consuming public trailing text', (key, keyQuote, valueQuote) => {
  const head = `{${keyQuote}${key}${keyQuote}: ${valueQuote}`;
  const secret = '-----BEGIN PRIVATE KEY-----\nfixture-secret\n-----END PRIVATE KEY-----';
  const tail = `${valueQuote}, 'note': 'first public line\nsecond public line'}`;
  expect(redactTextSecrets(`${head}${secret}${tail}`)).toBe(`${head}<redacted>${tail}`);
});

it('retains ordinary public headers', () => {
  const text = "{'content-type': 'application/json', 'x-title': 'OpenHands'}";
  expect(redactTextSecrets(text)).toBe(text);
});
