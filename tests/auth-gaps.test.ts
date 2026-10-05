import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import jwt from 'jsonwebtoken';
process.env.PUBLIC_SIGNUP_ROLE = 'BUYER';
process.env.GOOGLE_CLIENT_ID = 'm1-fixture.apps.googleusercontent.com';
process.env.EMAIL_QUEUE_NAME = `imet-m1-gaps-${randomUUID()}`;
const { config } = await import('../src/config/env.js');
const { prisma, disconnectDatabase } =
  await import('../src/config/database.js');
const { authService } = await import('../src/modules/auth/auth.service.js');
const { verifyGoogleIdentity } = await import('../src/modules/auth/google.js');
const { getEmailQueue, closeEmailQueue } =
  await import('../src/emails/queue.js');
const { dispatchAuthEmails, deliverAuthEmail } =
  await import('../src/emails/authIntents.js');
const { AuthRateStore, closeAuthRateStore } =
  await import('../src/modules/auth/authRateStore.js');
const { default: app } = await import('../src/app.js');
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const { privateKey: otherKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'fixture-key',
  use: 'sig',
};
const originalFetch = globalThis.fetch;
const marker = `m1-gaps-${randomUUID()}`;
const password = 'MachinerySecure123!';
const googleToken = (
  email: string,
  sub: string,
  extra: Record<string, unknown> = {},
  signingKey = privateKey,
) =>
  jwt.sign(
    { email, email_verified: true, name: 'Google buyer', sub, ...extra },
    signingKey,
    {
      algorithm: 'RS256',
      keyid: jwk.kid,
      audience: config.GOOGLE_CLIENT_ID,
      issuer: 'https://accounts.google.com',
      expiresIn: 3600,
    },
  );

test('M1 gaps: verified Google identity/linking, password lifecycle, durable email recovery and distributed limits', async (t) => {
  globalThis.fetch = (async (url, options) =>
    String(url) === 'https://www.googleapis.com/oauth2/v3/certs'
      ? new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { 'Content-Type': 'application/json' },
        })
      : originalFetch(url, options)) as typeof fetch;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1/auth`;
  const request = async (path: string, body: unknown, accessToken?: string) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const email = `${marker}@example.test`;
  const queue = getEmailQueue();
  try {
    await t.test(
      'signature, issuer, audience, expiry, verified email and strict caller input are enforced',
      async () => {
        const good = googleToken(email, marker);
        assert.equal((await verifyGoogleIdentity(good)).email, email);
        for (const credential of [
          googleToken(email, marker, { email_verified: false }),
          googleToken(email, marker, {}, otherKey),
          jwt.sign({ email, email_verified: true, sub: marker }, privateKey, {
            algorithm: 'RS256',
            keyid: jwk.kid,
            issuer: 'https://evil.test',
            audience: config.GOOGLE_CLIENT_ID,
            expiresIn: 3600,
          }),
          jwt.sign({ email, email_verified: true, sub: marker }, privateKey, {
            algorithm: 'RS256',
            keyid: jwk.kid,
            issuer: 'https://accounts.google.com',
            audience: 'another-client',
            expiresIn: 3600,
          }),
          jwt.sign({ email, email_verified: true, sub: marker }, privateKey, {
            algorithm: 'RS256',
            keyid: jwk.kid,
            issuer: 'https://accounts.google.com',
            audience: config.GOOGLE_CLIENT_ID,
            expiresIn: -1,
          }),
          jwt.sign({ email, sub: marker }, 'untrusted', { algorithm: 'HS256' }),
        ])
          await assert.rejects(
            verifyGoogleIdentity(credential),
            /Invalid or expired/,
          );
        assert.equal(
          (await request('/google', { idToken: good, role: 'ADMIN' })).status,
          422,
        );
        assert.equal(
          (await request('/google/link', { idToken: good })).status,
          401,
        );
      },
    );
    await t.test(
      'Google creates one Buyer under concurrent login, preserves sessions/status, and cannot silently relink',
      async () => {
        const credential = googleToken(email, marker);
        const [a, b] = await Promise.all([
          authService.google(credential),
          authService.google(credential),
        ]);
        assert.equal(a.user.id, b.user.id);
        assert.deepEqual(a.user.roles, ['BUYER']);
        assert.equal(a.user.isEmailVerified, true);
        assert.equal(await prisma.user.count({ where: { email } }), 1);
        await assert.rejects(
          authService.login(email, password),
          /Invalid email or password/,
        );
        const refreshed = await authService.refresh(a.refreshToken);
        assert.equal(refreshed.user.id, a.user.id);
        await authService.logout(
          a.user.id,
          (
            await prisma.userSession.findUniqueOrThrow({
              where: {
                refreshTokenHash: (
                  await import('../src/utils/tokens.js')
                ).tokenHash(b.refreshToken),
              },
            })
          ).id,
        );
        await assert.rejects(
          authService.refresh(b.refreshToken),
          /Invalid or expired session/,
        );
        await assert.rejects(
          authService.google(googleToken(email, 'different-subject')),
          /Sign in with your password/,
        );
        await prisma.user.update({
          where: { email },
          data: { status: 'SUSPENDED' },
        });
        await assert.rejects(
          authService.google(credential),
          /Account is not active/,
        );
        await prisma.user.update({
          where: { email },
          data: { status: 'ACTIVE' },
        });
      },
    );
    await t.test(
      'verified password account requires authenticated, matching Google linking',
      async () => {
        const linkEmail = `link-${email}`;
        await authService.register({
          email: linkEmail,
          displayName: 'Existing buyer',
          password,
        });
        const pending = await prisma.user.findUniqueOrThrow({
          where: { email: linkEmail },
        });
        const credential = googleToken(linkEmail, `link-${marker}`);
        await assert.rejects(
          authService.google(credential),
          /Sign in with your password/,
        );
        await assert.rejects(
          authService.google(credential, pending.id),
          /Account cannot be linked/,
        );
        await prisma.user.update({
          where: { id: pending.id },
          data: { isEmailVerified: true, status: 'ACTIVE' },
        });
        const existing = await authService.login(linkEmail, password);
        await assert.rejects(
          authService.google(
            googleToken(`wrong-${email}`, 'wrong-sub'),
            pending.id,
          ),
          /must match/,
        );
        assert.equal(
          (
            await request(
              '/google/link',
              { idToken: credential },
              existing.accessToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (await authService.google(credential)).user.id,
          existing.user.id,
        );
        assert.equal(
          (await authService.login(linkEmail, password)).user.id,
          existing.user.id,
        );
      },
    );
    await t.test(
      'queue failure persists encrypted intent; retry recovers same token and delivery is idempotent',
      async () => {
        const recoverEmail = `recover-${email}`;
        const originalAdd = queue.add.bind(queue);
        queue.add = async () => {
          throw new Error('Fixture Redis outage');
        };
        try {
          await authService.register({
            email: recoverEmail,
            displayName: 'Recovery buyer',
            password,
          });
        } finally {
          queue.add = originalAdd;
        }
        const user = await prisma.user.findUniqueOrThrow({
          where: { email: recoverEmail },
        });
        const intent = await prisma.authEmailIntent.findFirstOrThrow({
          where: { userId: user.id },
        });
        assert.notEqual(intent.encryptedToken, user.emailVerificationTokenHash);
        assert.ok(!/^[a-f0-9]{64}$/.test(intent.encryptedToken));
        assert.equal(await queue.getJob(intent.id), undefined);
        await authService.register({
          email: recoverEmail,
          displayName: 'Duplicate ignored',
          password,
        });
        const job = await queue.getJob(intent.id);
        assert.ok(job);
        const token = new URL(
          job.data.html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'),
        ).searchParams.get('token')!;
        assert.equal(
          (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
            .emailVerificationTokenHash,
          user.emailVerificationTokenHash,
        );
        let sends = 0;
        const provider = {
          send: async (_data: unknown, id: string) => {
            sends++;
            assert.equal(id, intent.id);
            return { id: 'fixture-message' };
          },
        };
        await deliverAuthEmail(intent.id, provider);
        await deliverAuthEmail(intent.id, provider);
        assert.equal(sends, 1);
        assert.equal(
          (
            await prisma.authEmailIntent.findUniqueOrThrow({
              where: { id: intent.id },
            })
          ).encryptedToken,
          '',
        );
        await authService.verify(token);
        await assert.rejects(authService.verify(token), /Invalid or expired/);
        await authService.forgot(recoverEmail);
        const resetIntent = await prisma.authEmailIntent.findFirstOrThrow({
          where: { userId: user.id, purpose: 'reset-password' },
        });
        const resetJob = await queue.getJob(resetIntent.id);
        assert.ok(resetJob);
        const resetToken = new URL(
          resetJob.data.html
            .match(/href="([^"]+)"/)![1]
            .replaceAll('&amp;', '&'),
        ).searchParams.get('token')!;
        assert.equal(
          (
            await request('/reset-password', {
              token: resetToken,
              password,
              confirmPassword: 'Mismatch',
            })
          ).status,
          422,
        );
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordResetExpires: new Date(0) },
        });
        await assert.rejects(
          authService.reset(resetToken, password),
          /Invalid or expired/,
        );
        await authService.forgot(recoverEmail);
        let staleSends = 0;
        await deliverAuthEmail(resetIntent.id, {
          send: async () => {
            staleSends++;
            return { id: 'must-not-send' };
          },
        });
        assert.equal(staleSends, 0);
        await dispatchAuthEmails();
      },
    );
    await t.test(
      'Google-only user can establish a credentials password through verified reset',
      async () => {
        await authService.forgot(email);
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        const intent = await prisma.authEmailIntent.findFirstOrThrow({
          where: { userId: user.id, purpose: 'reset-password' },
        });
        const job = await queue.getJob(intent.id);
        assert.ok(job);
        const token = new URL(
          job.data.html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'),
        ).searchParams.get('token')!;
        await authService.reset(token, password);
        assert.equal(
          (await authService.login(email, password)).user.id,
          user.id,
        );
        assert.equal(
          (await authService.google(googleToken(email, marker))).user.id,
          user.id,
        );
      },
    );
    await t.test(
      'coordinated refresh across callers returns one rotation, expires and respects revocation',
      async () => {
        const initial = await authService.login(email, password);
        const [first, second] = await Promise.all([
          authService.refresh(initial.refreshToken, true),
          authService.refresh(initial.refreshToken, true),
        ]);
        assert.equal(first.refreshToken, second.refreshToken);
        assert.equal(first.accessToken, second.accessToken);
        await assert.rejects(
          authService.refresh(initial.refreshToken),
          /Invalid or expired session/,
        );
        const cache = await prisma.authRefreshHandoff.findUniqueOrThrow({
          where: {
            tokenHash: (await import('../src/utils/tokens.js')).tokenHash(
              initial.refreshToken,
            ),
          },
        });
        assert.ok(!cache.encryptedResult.includes(first.refreshToken));
        await prisma.authRefreshHandoff.update({
          where: { tokenHash: cache.tokenHash },
          data: { expiresAt: new Date(0) },
        });
        await assert.rejects(
          authService.refresh(initial.refreshToken, true),
          /Invalid or expired session/,
        );
        const live = await authService.login(email, password);
        await authService.refresh(live.refreshToken, true);
        const session = await prisma.authRefreshHandoff.findUniqueOrThrow({
          where: {
            tokenHash: (await import('../src/utils/tokens.js')).tokenHash(
              live.refreshToken,
            ),
          },
        });
        await authService.logout(first.user.id, session.sessionId);
        await assert.rejects(
          authService.refresh(live.refreshToken, true),
          /Invalid or expired session/,
        );
      },
    );
    await t.test(
      'Google attempts are limited per subject without blocking other frontend users',
      async () => {
        const credential = googleToken(email, `limited-${marker}`, {
          email_verified: false,
        });
        for (let attempt = 0; attempt < 20; attempt++)
          assert.equal(
            (await request('/google', { idToken: credential })).status,
            401,
          );
        assert.equal(
          (await request('/google', { idToken: credential })).status,
          429,
        );
        assert.equal(
          (
            await request('/google', {
              idToken: googleToken(email, `other-${marker}`, {
                email_verified: false,
              }),
            })
          ).status,
          401,
        );
      },
    );
    await t.test('separate limiter instances share counters', async () => {
      const prefix = `imet-test-limit-${marker}`;
      const first = new AuthRateStore(prefix);
      const second = new AuthRateStore(prefix);
      first.init({ windowMs: 1000 });
      second.init({ windowMs: 1000 });
      assert.equal((await first.increment('fixture')).totalHits, 1);
      assert.equal((await second.increment('fixture')).totalHits, 2);
      await first.resetKey('fixture');
    });
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.user.deleteMany({ where: { email: { endsWith: email } } });
    for (const job of await queue.getJobs(['waiting', 'failed']))
      await job.remove();
    await closeEmailQueue();
    await closeAuthRateStore();
    await disconnectDatabase();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
