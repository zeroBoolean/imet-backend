import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Queue } from 'bullmq';
process.env.EMAIL_QUEUE_NAME = `imet-worker-test-${randomUUID()}`;
const { prisma, disconnectDatabase } =
  await import('../src/config/database.js');
const { config } = await import('../src/config/env.js');
const { newToken } = await import('../src/utils/tokens.js');
const { recordAuthEmail } = await import('../src/emails/authIntents.js');
const { createRedisConnection } =
  await import('../src/emails/redisConnection.js');

test('normal email worker recovers persisted auth intent and exits cleanly after SIGTERM without delivering mail', async () => {
  const connection = createRedisConnection();
  const queue = new Queue(config.EMAIL_QUEUE_NAME, { connection });
  const token = newToken();
  const { user, intent } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `worker-${randomUUID()}@example.test`,
        displayName: 'Worker fixture',
        password: 'unused-fixture-hash',
        emailVerificationTokenHash: token.hash,
        emailVerificationExpires: new Date(Date.now() + 60000),
      },
    });
    const intent = await recordAuthEmail(
      tx,
      user.id,
      'verify-user',
      token,
      new Date(Date.now() + 60000),
    );
    return { user, intent };
  });
  await queue.pause(); // No provider call/email can occur during this operational test.
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/emails/worker.ts'],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        RESEND_API_KEY: 'fixture-not-a-live-key',
        RESEND_FROM_EMAIL: 'fixture@example.test',
      },
      stdio: 'ignore',
    },
  );
  const exit = new Promise<number | null>((resolve) =>
    child.once('exit', resolve),
  );
  try {
    const until = Date.now() + 10000;
    while (!(await queue.getJob(intent.id)) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const job = await queue.getJob(intent.id);
    assert.ok(job, 'worker must recover this DB intent into real Redis');
    assert.equal(job.data.authIntentId, intent.id);
    assert.equal(job.data.to, user.email);
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error('Worker did not close recovery producer connection'),
              ),
            5000,
          );
        }),
      ]);
      assert.equal(code, 0);
    } finally {
      if (timer) clearTimeout(timer);
    }
    assert.equal(
      (
        await prisma.authEmailIntent.findFirstOrThrow({
          where: { userId: user.id },
        })
      ).sentAt,
      null,
    );
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await exit;
    }
    await prisma.user.delete({ where: { id: user.id } });
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
    await disconnectDatabase();
  }
});
