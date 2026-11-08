'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUrl, parseDomain, csvCell, safeCell, parseLine, audit, fetchWithRetry } = require('../core.js');

test('validates URLs and rejects credentials and unsupported schemes', () => {
  assert.equal(buildUrl('example.com/ads.txt'), 'https://example.com/ads.txt');
  assert.equal(buildUrl('https://user:pass@example.com/'), null);
  assert.equal(buildUrl('ftp://example.com/'), null);
  assert.equal(buildUrl('example.com/a b'), null);
  assert.equal(parseDomain('HTTPS://WWW.Example.com/path'), 'example.com');
});

test('protects spreadsheet exports and preserves CSV quoting', () => {
  assert.equal(csvCell('  =1+1'), '"\'  =1+1"');
  assert.equal(csvCell('hello, "world"'), '"hello, ""world"""');
  assert.equal(safeCell('\t@command'), "'\t@command");
});

test('matches the requested relationship among multiple records', () => {
  const ref = { ...parseLine('EXAMPLE.com, Pub-1, DIRECT'), original: 'example.com, Pub-1, DIRECT' };
  const content = '# OWNERDOMAIN=wrong.example\nOWNERDOMAIN=right.example\nexample.com, pub-1, RESELLER\nexample.com, pub-1, DIRECT\nexample.com, pub-1, DIRECT\n';
  const [result] = audit(content, 'target', [ref]);
  assert.equal(result.status, 'Valid');
  assert.equal(result.details, 'Matched (duplicate in file)');
  assert.equal(result.owner, 'Owner: right.example');
  assert.equal(audit('example.com, pub-1, RESELLER', 'target', [ref])[0].status, 'Partial');
  assert.equal(audit('', 'target', [ref])[0].status, 'Not Found');
});

test('fetch omits credentials and does not retry permanent HTTP errors', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async (_url, options) => {
    calls++;
    assert.equal(options.credentials, 'omit');
    return new Response('missing', { status: 404 });
  };
  await assert.rejects(fetchWithRetry('https://example.com', new AbortController().signal), /HTTP 404/);
  assert.equal(calls, 1);
});

test('cancellation interrupts an active request', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const controller = new AbortController();
  const request = fetchWithRetry('https://example.com', controller.signal);
  controller.abort();
  await assert.rejects(request, /Aborted/);
});

test('rejects oversized responses', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response('body', { headers: { 'content-length': String(11 * 1024 * 1024) } });
  await assert.rejects(fetchWithRetry('https://example.com', new AbortController().signal), /10 MB/);
});
