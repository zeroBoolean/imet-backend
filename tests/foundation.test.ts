import express from 'express';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import app from '../src/app.js';
import { disconnectDatabase } from '../src/config/database.js';
import { config } from '../src/config/env.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { validate } from '../src/middleware/validation.js';

let server: Server;
let base: string;
before(async () => {
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await disconnectDatabase();
});

test('readiness executes a real PostgreSQL query', async () => {
  const response = await fetch(`${base}/api/v1/health`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { status: 'ready', database: 'connected' });
});
test('unknown resource returns the standard error contract', async () => {
  const response = await fetch(`${base}/api/v1/missing`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, 'Resource not found');
});
test('malformed JSON returns a safe error without exposing parser details', async () => {
  const response = await fetch(`${base}/api/v1/health`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, 'Invalid JSON body');
});
// test('security headers and configured frontend CORS are returned', async () => {
//   const response = await fetch(`${base}/api/v1/health`, {
//     headers: { Origin: 'http://localhost:3000' },
//   });
//   assert.equal(
//     response.headers.get('access-control-allow-origin'),
//     'http://localhost:3000',
//   );
//   assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
//   assert.equal(response.headers.get('x-powered-by'), null);
// });
test('security headers and configured frontend CORS are returned', async () => {
  const response = await fetch(`${base}/api/v1/health`, {
    headers: { Origin: config.FRONTEND_URL },
  });

  assert.equal(
    response.headers.get('access-control-allow-origin'),
    config.FRONTEND_URL,
  );

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-powered-by'), null);
});
test('validation preserves transformations and provides field errors', async () => {
  const fixture = express();
  fixture.use(express.json());
  fixture.post(
    '/form',
    validate(
      z.object({
        body: z.object({ count: z.coerce.number().int().positive() }),
      }),
    ),
    (_req, res) => res.json(res.locals.validated.body),
  );
  fixture.use(errorHandler);
  const local = await new Promise<Server>((resolve) => {
    const listening = fixture.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = local.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/form`;
    const valid = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"count":"3"}',
    });
    assert.deepEqual(await valid.json(), { count: 3 });
    const invalid = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"count":-1}',
    });
    assert.equal(invalid.status, 422);
    const body = await invalid.json();
    assert.equal(body.success, false);
    assert.deepEqual(body.errors[0].path, ['body', 'count']);
  } finally {
    await new Promise<void>((resolve) => local.close(() => resolve()));
  }
});
