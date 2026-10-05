import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Server } from 'node:http';
// This policy is exclusively a test fixture, not the public application's configuration.
process.env.PUBLIC_SIGNUP_ROLE = 'BUYER';
process.env.EMAIL_QUEUE_NAME = `imet-test-${randomUUID()}`;
const { default: app } = await import('../src/app.js');
const { prisma, disconnectDatabase } =
  await import('../src/config/database.js');
const { getEmailQueue, closeEmailQueue } =
  await import('../src/emails/queue.js');
const { tokenHash } = await import('../src/utils/tokens.js');

test('complete authentication flow, single-use tokens, rotation, revocation and account restrictions', async () => {
  const email = `m1-${randomUUID()}@example.test`;
  const password = 'MachinerySecure123!';
  const nextPassword = 'NewMachinerySecure456!';
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/auth`;
  const jobs: string[] = [];
  const request = async (path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const mailToken = async () => {
    const waiting = await getEmailQueue().getJobs(['waiting']);
    const job = waiting.find(
      (job) => job.data.to === email && !jobs.includes(job.id!),
    );
    assert.ok(job, 'email must have been enqueued in Redis');
    jobs.push(job.id!);
    const link = job.data.html
      .match(/href="([^"]+)"/)![1]
      .replaceAll('&amp;', '&');
    return new URL(link).searchParams.get('token')!;
  };
  try {
    assert.equal(
      (
        await request('/register', {
          displayName: 'Test Buyer',
          email,
          password,
          role: 'ADMIN',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await request('/register', {
          displayName: 'Test Buyer',
          email,
          password,
        })
      ).status,
      200,
    );
    let verification = await mailToken();
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { assignedRole: true },
    });
    assert.deepEqual(
      user.assignedRole.map((role) => role.role),
      ['BUYER'],
    );
    assert.ok(user.password.startsWith('$argon2id$'));
    assert.equal(user.emailVerificationTokenHash, tokenHash(verification));
    assert.notEqual(user.emailVerificationTokenHash, verification);
    assert.equal((await request('/login', { email, password })).status, 403);
    assert.equal(
      (await request('/resend-verification', { email })).status,
      200,
    );
    assert.equal(
      (await request('/verify-user', { token: verification })).status,
      400,
    );
    verification = await mailToken();
    await prisma.user.update({
      where: { email },
      data: { emailVerificationExpires: new Date(Date.now() - 1000) },
    });
    assert.equal(
      (await request('/verify-user', { token: verification })).status,
      400,
    );
    assert.equal(
      (await request('/resend-verification', { email })).status,
      200,
    );
    verification = await mailToken();
    assert.equal(
      (await request('/verify-user', { token: verification })).status,
      200,
    );
    assert.equal(
      (await request('/verify-user', { token: verification })).status,
      400,
    );
    assert.equal(
      (await request('/login', { email, password: 'WrongPassword1' })).status,
      401,
    );
    const first = await request('/login', { email, password });
    assert.equal(first.status, 200);
    const auth = first.body.data;
    assert.equal(auth.user.password, undefined);
    assert.equal((await request('/me')).status, 401);
    assert.equal(
      (await request('/me', undefined, auth.accessToken)).status,
      200,
    );
    const adminURL = base.replace(/auth$/, 'user');
    assert.equal(
      (
        await fetch(adminURL, {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
        })
      ).status,
      403,
    );
    const admin = await prisma.user.create({
      data: {
        email: `admin-${email}`,
        displayName: 'Fixture Admin',
        password: user.password,
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { create: { role: 'ADMIN' } },
      },
    });
    try {
      const adminAuth = (
        await request('/login', { email: admin.email, password })
      ).body.data;
      const headers = {
        Authorization: `Bearer ${adminAuth.accessToken}`,
        'Content-Type': 'application/json',
      };
      const roster = await fetch(adminURL, { headers });
      assert.equal(roster.status, 200);
      assert.equal(
        (await roster.json()).data.users.some(
          (entry: { password?: string }) => entry.password,
        ),
        false,
      );
      assert.equal(
        (
          await fetch(`${adminURL}/${admin.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ status: 'SUSPENDED' }),
          })
        ).status,
        403,
      );
      const target = await prisma.user.create({
        data: {
          email: `target-${email}`,
          displayName: 'Fixture Target',
          password: user.password,
          status: 'ACTIVE',
          isEmailVerified: true,
          assignedRole: { create: { role: 'BUYER' } },
        },
      });
      try {
        const before = (
          await request('/login', { email: target.email, password })
        ).body.data;
        const update = await fetch(`${adminURL}/${target.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ roles: ['LOCAL_SUPPLPLIER'] }),
        });
        assert.equal(update.status, 422);
        const changed = await fetch(`${adminURL}/${target.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ roles: ['LOCAL_SUPPLIER'] }),
        });
        assert.equal(changed.status, 200);
        assert.equal(
          (await request('/me', undefined, before.accessToken)).status,
          401,
        );
        assert.deepEqual(
          (await request('/login', { email: target.email, password })).body.data
            .user.roles,
          ['LOCAL_SUPPLIER'],
        );
        const suspend = await fetch(`${adminURL}/${target.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ status: 'SUSPENDED' }),
        });
        assert.equal(suspend.status, 200);
        assert.equal(
          (await request('/login', { email: target.email, password })).status,
          403,
        );
        await prisma.user.update({
          where: { id: target.id },
          data: { isEmailVerified: false },
        });
        assert.equal(
          (
            await fetch(`${adminURL}/${target.id}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({ status: 'ACTIVE' }),
            })
          ).status,
          400,
        );
      } finally {
        await prisma.user.delete({ where: { id: target.id } });
      }
      const profile = await fetch(`${adminURL}/me`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Updated Buyer' }),
      });
      assert.equal(profile.status, 200);
      assert.equal((await profile.json()).data.displayName, 'Updated Buyer');
    } finally {
      await prisma.auditLog.deleteMany({ where: { actorId: admin.id } });
      await prisma.user.delete({ where: { id: admin.id } });
    }
    const refreshed = await request('/refresh', {
      refreshToken: auth.refreshToken,
    });
    assert.equal(refreshed.status, 200);
    assert.equal(
      (await request('/refresh', { refreshToken: auth.refreshToken })).status,
      401,
    );
    assert.equal(
      (await request('/logout', {}, refreshed.body.data.accessToken)).status,
      200,
    );
    assert.equal(
      (await request('/me', undefined, refreshed.body.data.accessToken)).status,
      401,
    );
    assert.equal(
      (
        await request('/refresh', {
          refreshToken: refreshed.body.data.refreshToken,
        })
      ).status,
      401,
    );
    const another = (await request('/login', { email, password })).body.data;
    assert.equal((await request('/forgot-password', { email })).status, 200);
    const resetToken = await mailToken();
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { email } }))
        .passwordResetTokenHash,
      tokenHash(resetToken),
    );
    assert.equal(
      (
        await request('/reset-password', {
          token: resetToken,
          password: nextPassword,
          confirmPassword: nextPassword,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request('/reset-password', {
          token: resetToken,
          password: nextPassword,
          confirmPassword: nextPassword,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request('/me', undefined, another.accessToken)).status,
      401,
    );
    assert.equal((await request('/login', { email, password })).status, 401);
    const changed = (await request('/login', { email, password: nextPassword }))
      .body.data;
    assert.equal(
      (
        await request(
          '/change-password',
          {
            currentPassword: nextPassword,
            password,
            confirmPassword: password,
          },
          changed.accessToken,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request('/me', undefined, changed.accessToken)).status,
      401,
    );
    const sessionA = (await request('/login', { email, password })).body.data;
    const sessionB = (await request('/login', { email, password })).body.data;
    assert.equal(
      (await request('/logout-all', {}, sessionA.accessToken)).status,
      200,
    );
    assert.equal(
      (await request('/me', undefined, sessionB.accessToken)).status,
      401,
    );
    const current = (await request('/login', { email, password })).body.data;
    await prisma.user.update({
      where: { email },
      data: { status: 'SUSPENDED' },
    });
    assert.equal(
      (await request('/me', undefined, current.accessToken)).status,
      403,
    );
    assert.equal(
      (await request('/refresh', { refreshToken: current.refreshToken }))
        .status,
      401,
    );
    assert.equal((await request('/login', { email, password })).status, 403);
    const unknown = await request('/forgot-password', {
      email: `unknown-${randomUUID()}@example.test`,
    });
    assert.equal(unknown.status, 200);
    assert.equal(
      unknown.body.message,
      'If this address is eligible, you will receive an email shortly.',
    );
  } finally {
    await prisma.auditLog.deleteMany({ where: { actor: { email } } });
    await prisma.user.deleteMany({ where: { email } });
    for (const job of await getEmailQueue().getJobs(['waiting']))
      await job.remove();
    await closeEmailQueue();
    await disconnectDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
