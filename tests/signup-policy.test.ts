import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
delete process.env.PUBLIC_SIGNUP_ROLE;
const { default: app } = await import('../src/app.js');
const { disconnectDatabase } = await import('../src/config/database.js');

test('public registration remains disabled until signup policy is configured', async () => {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/auth/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Fixture',
          email: 'blocked@example.test',
          password: 'FixturePassword123!',
        }),
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).success, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
});
