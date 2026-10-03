import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { errorHandler } from '../src/middleware/errorHandler.js';

test('unexpected errors are masked and oversized JSON is rejected', async () => {
  const fixture = express();
  fixture.use(express.json({ limit: '1kb' }));
  fixture.post('/body', (_req, res) => res.json({ success: true }));
  fixture.get('/error', () => {
    throw new Error('private connection details');
  });
  fixture.use(errorHandler);
  const server = await new Promise<Server>((resolve) => {
    const listening = fixture.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const error = await fetch(`${base}/error`);
    assert.equal(error.status, 500);
    assert.equal((await error.json()).message, 'Internal server error');
    const oversized = await fetch(`${base}/body`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(2048) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).message, 'Request body is too large');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
