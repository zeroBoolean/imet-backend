import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bunnyStorage } from '../src/services/bunnyStorage.js';
import { config } from '../src/config/env.js';
import { storageRequest } from '../src/modules/rfq/rfqAttachment.service.js';
test('shared Bunny transport protects fixed hosts, namespaces, credentials, timeout and retryable delete semantics', async (t) => {
  const zone = config.BUNNY_STORAGE_ZONE,
    key = config.BUNNY_STORAGE_ACCESS_KEY;
  config.BUNNY_STORAGE_ZONE = 'fixture-zone';
  config.BUNNY_STORAGE_ACCESS_KEY = 'fixture-not-real';
  let status = 201;
  const mocked = t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.match(
        String(input),
        /^https:\/\/storage.bunnycdn.com\/fixture-zone\/(rfq|machinery|catalogue|supplier)\//,
      );
      assert.equal(init?.redirect, 'error');
      assert.equal(
        new Headers(init?.headers).get('AccessKey'),
        'fixture-not-real',
      );
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(null, { status });
    },
  );
  const id = '00000000-0000-4000-8000-000000000000',
    media = `machinery/${id}/${id}.glb`,
    rfq = `rfq/${id}/${id}.pdf`,
    catalogue = `catalogue/${id}/${id}.png`,
    supplier = `supplier/${id}/${id}.pdf`;
  try {
    await bunnyStorage.request(media, 'PUT', Buffer.from('fixture'));
    await bunnyStorage.request(catalogue, 'PUT', Buffer.from('fixture'));
    await bunnyStorage.request(supplier, 'PUT', Buffer.from('fixture'));
    await assert.rejects(storageRequest(supplier, 'GET'));
    await assert.rejects(
      bunnyStorage.request(`supplier/${id}/${id}.svg`, 'GET'),
    );
    await assert.rejects(storageRequest(catalogue, 'GET'));
    await storageRequest(rfq, 'PUT', Buffer.from('fixture'));
    await assert.rejects(storageRequest(media, 'GET'));
    await assert.rejects(bunnyStorage.request('../rfq/private', 'GET'));
    status = 404;
    await bunnyStorage.request(media, 'DELETE');
    await assert.rejects(bunnyStorage.request(media, 'GET'));
    status = 503;
    await assert.rejects(bunnyStorage.request(media, 'PUT'));
    config.BUNNY_STORAGE_ACCESS_KEY = undefined;
    await assert.rejects(bunnyStorage.request(media, 'GET'));
  } finally {
    mocked.mock.restore();
    config.BUNNY_STORAGE_ZONE = zone;
    config.BUNNY_STORAGE_ACCESS_KEY = key;
  }
});
