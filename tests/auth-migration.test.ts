import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config/env.js';

test('M1 additive Google/outbox/refresh migrations preserve existing auth data and identity uniqueness', async () => {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  const schema = `m1_upgrade_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const root = new URL('../prisma/migrations/', import.meta.url);
    const migrations = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const cutoff = '20261005120000_m1_auth_completion';
    for (const migration of migrations.filter((name) => name < cutoff))
      await client.query(
        await readFile(new URL(`${migration}/migration.sql`, root), 'utf8'),
      );
    await client.query(
      `INSERT INTO users (id,email,"displayName",password,status,"isEmailVerified","updatedAt") VALUES ('preserved','preserved@example.test','Preserved user','preserved-password-hash','ACTIVE',true,NOW())`,
    );
    await client.query(
      `INSERT INTO user_role_assignments ("userId",role) VALUES ('preserved','BUYER')`,
    );
    await client.query(
      `INSERT INTO user_sessions (id,"userId","refreshTokenHash","expiresAt") VALUES ('session','preserved','preserved-refresh-hash',NOW()+interval '1 day')`,
    );
    const before = (await client.query('SELECT * FROM users')).rows;
    const roles = (await client.query('SELECT * FROM user_role_assignments'))
      .rows;
    const sessions = (await client.query('SELECT * FROM user_sessions')).rows;
    for (const migration of migrations.filter((name) => name >= cutoff))
      await client.query(
        await readFile(new URL(`${migration}/migration.sql`, root), 'utf8'),
      );
    const after = (await client.query('SELECT * FROM users')).rows.map(
      ({ googleSubject, ...user }) => {
        assert.equal(googleSubject, null);
        return user;
      },
    );
    assert.deepEqual(after, before);
    assert.deepEqual(
      (await client.query('SELECT * FROM user_role_assignments')).rows,
      roles,
    );
    assert.deepEqual(
      (await client.query('SELECT * FROM user_sessions')).rows,
      sessions,
    );
    await client.query(
      `UPDATE users SET "googleSubject"='fixture-subject' WHERE id='preserved'`,
    );
    await client.query('SAVEPOINT duplicate_identity');
    await assert.rejects(
      client.query(
        `INSERT INTO users (id,email,"displayName",password,"googleSubject","updatedAt") VALUES ('duplicate','duplicate@example.test','Duplicate','fixture','fixture-subject',NOW())`,
      ),
      /unique constraint/,
    );
    await client.query('ROLLBACK TO SAVEPOINT duplicate_identity');
    await client.query(
      `INSERT INTO auth_email_intents (id,"userId",purpose,"tokenHash","encryptedToken","expiresAt") VALUES ('intent','preserved','verify-user','hash','encrypted',NOW()+interval '1 hour')`,
    );
    await client.query(
      `INSERT INTO auth_refresh_handoffs ("tokenHash","sessionId","encryptedResult","expiresAt") VALUES ('previous-hash','session','encrypted',NOW()+interval '5 seconds')`,
    );
    await client.query(`DELETE FROM users WHERE id='preserved'`);
    assert.equal(
      (await client.query('SELECT * FROM auth_email_intents')).rowCount,
      0,
    );
    assert.equal(
      (await client.query('SELECT * FROM auth_refresh_handoffs')).rowCount,
      0,
    );
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
