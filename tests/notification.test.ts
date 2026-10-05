import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Worker, QueueEvents } from 'bullmq';
process.env.EMAIL_QUEUE_NAME = `imet-m11-${randomUUID()}`;
const { default: app } = await import('../src/app.js');
const { prisma, disconnectDatabase } =
  await import('../src/config/database.js');
const { signAccessToken } = await import('../src/utils/jwt.js');
const { completedPurchase, cleanTicketFixtures } =
  await import('./helpers/serviceTicketFixtures.js');
const { prepareNotificationEmail, recordServiceNotifications } =
  await import('../src/modules/notification/notification.service.js');
const { dispatchDelivery, deliverEmail, safeRetryWindowMs } =
  await import('../src/modules/notification/notification.jobs.js');
const { getEmailQueue, closeEmailQueue } =
  await import('../src/emails/queue.js');
const { createRedisConnection } =
  await import('../src/emails/redisConnection.js');
const { serviceEmail } =
  await import('../src/emails/templates/serviceEmail.js');
const { authEmailText } = await import('../src/emails/templates/authEmail.js');
const { rfqEmailText } = await import('../src/emails/templates/rfqEmail.js');
import type { UserRole } from '../src/generated/client.js';
import type { EmailJob } from '../src/emails/queue.js';

test('M11 transactional email recipients, privacy, durable delivery and failure isolation', async (t) => {
  const marker = `notification-test-${randomUUID()}`,
    users: string[] = [];
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = async (
    path: string,
    token: string,
    body: unknown,
    method = 'POST',
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const account = async (role: UserRole, verified = true, active = true) => {
    const u = await prisma.user.create({
      data: {
        email: `${marker}-${users.length}@example.test`,
        displayName: '<script>SECRET NAME</script>',
        password: 'fixture',
        status: active ? 'ACTIVE' : 'SUSPENDED',
        isEmailVerified: verified,
        assignedRole: { create: { role } },
        sessions: {
          create: {
            refreshTokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 3600000),
          },
        },
      },
      include: { sessions: true },
    });
    users.push(u.id);
    return { id: u.id, token: signAccessToken(u.id, u.sessions[0].id) };
  };
  let categoryId: string | undefined;
  const queue = getEmailQueue();
  try {
    const buyer = await account('BUYER'),
      admin = await account('ADMIN'),
      agent = await account('SALES_PERSON'),
      next = await account('SALES_PERSON');
    await account('ADMIN', false);
    await account('ADMIN', true, false);
    const category = await prisma.machineCategory.create({
      data: { name: marker, slug: marker },
    });
    categoryId = category.id;
    const machine = await prisma.machine.create({
      data: {
        name: marker,
        slug: marker,
        manufacturer: 'Original',
        model: '5 kW',
        description: 'ORIGINAL MACHINERY',
        categoryId: category.id,
        status: 'PUBLISHED',
      },
    });
    const purchase = await completedPurchase(
      buyer.id,
      agent.id,
      machine.id,
      category.id,
    );
    const create = (customerRequestId = randomUUID()) =>
      request('/service-tickets', buyer.token, {
        saleId: purchase.sale.id,
        customerRequestId,
        subject: 'PRIVATE SUBJECT',
        description: 'PRIVATE SERVICE DESCRIPTION',
        warrantyRequested: true,
      });
    const originalRequestId = randomUUID();
    const created = await create(originalRequestId);
    assert.equal(created.status, 201);
    const ticketId: string = created.body.data.id;
    const ticket = () =>
      prisma.serviceTicket.findUniqueOrThrow({ where: { id: ticketId } });
    const status = async (
      value: string,
      actor: { token: string },
      resolution?: string,
    ) =>
      request(
        `/service-tickets/${ticketId}/status`,
        actor.token,
        {
          status: value,
          updatedAt: (await ticket()).updatedAt.toISOString(),
          ...(value === 'IN_PROGRESS' ? { note: 'PRIVATE DIAGNOSIS' } : {}),
          ...(resolution ? { resolution } : {}),
        },
        'PATCH',
      );
    const assigned = async (id: string) =>
      request(
        `/admin/service-tickets/${ticketId}/assignment`,
        admin.token,
        {
          assignedToId: id,
          updatedAt: (await ticket()).updatedAt.toISOString(),
        },
        'PATCH',
      );
    const deliveries = async (type: string) =>
      prisma.notificationEmailDelivery.findMany({
        where: { event: { ticketId, type } },
        orderBy: { createdAt: 'asc' },
      });
    const freshIntent = async () => {
      const e = await prisma.serviceTicketEvent.create({
        data: { ticketId, actorId: admin.id, type: 'TICKET_UNDER_REVIEW' },
      });
      return prisma.notificationEmailDelivery.create({
        data: { eventId: e.id, userId: buyer.id },
      });
    };

    await t.test(
      'API lifecycle commits exact public event recipients; private progress has no email; retries deduplicate',
      async () => {
        const retry = await create(originalRequestId);
        assert.equal(retry.status, 201);
        assert.equal(retry.body.data.id, ticketId);
        assert.equal(
          await prisma.serviceTicketEvent.count({
            where: { ticketId, type: 'TICKET_CREATED' },
          }),
          1,
        );
        const creation = await deliveries('TICKET_CREATED');
        assert.deepEqual(
          new Set(creation.map((d) => d.userId)),
          new Set([buyer.id, admin.id]),
        );
        const e = await prisma.serviceTicketEvent.findFirstOrThrow({
          where: { ticketId, type: 'TICKET_CREATED' },
        });
        await prisma.$transaction(async (tx) =>
          recordServiceNotifications(
            tx,
            await tx.serviceTicket.findUniqueOrThrow({
              where: { id: ticketId },
            }),
            e,
          ),
        );
        assert.equal((await deliveries('TICKET_CREATED')).length, 2);
        assert.equal((await status('UNDER_REVIEW', admin)).status, 200);
        assert.equal((await assigned(agent.id)).status, 200);
        assert.deepEqual(
          new Set((await deliveries('TICKET_ASSIGNED')).map((d) => d.userId)),
          new Set([buyer.id, agent.id]),
        );
        assert.equal((await status('IN_PROGRESS', agent)).status, 200);
        for (const visibility of ['PUBLIC', 'INTERNAL']) {
          assert.equal(
            (
              await request(`/service-tickets/${ticketId}/notes`, agent.token, {
                updatedAt: (await ticket()).updatedAt.toISOString(),
                note: 'PRIVATE PROGRESS',
                visibility,
              })
            ).status,
            200,
          );
        }
        assert.equal(
          await prisma.notificationEmailDelivery.count({
            where: { event: { ticketId, type: 'SERVICE_PROGRESS' } },
          }),
          0,
        );
        assert.equal((await assigned(next.id)).status, 200);
        const oldAssignee = (await deliveries('TICKET_ASSIGNED')).find(
          (d) => d.userId === agent.id,
        );
        assert.ok(oldAssignee);
        assert.equal(
          await prepareNotificationEmail('service', oldAssignee.id),
          null,
        );
        assert.equal(
          (await status('RESOLVED', next, 'PRIVATE RESOLUTION')).status,
          200,
        );
        assert.equal(
          (
            await request(
              `/admin/service-tickets/${ticketId}/warranty`,
              admin.token,
              {
                updatedAt: (await ticket()).updatedAt.toISOString(),
                assessment: 'APPROVED',
                note: 'PRIVATE COVERAGE EXPLANATION',
              },
              'PATCH',
            )
          ).status,
          200,
        );
        assert.equal((await status('CLOSED', admin)).status, 200);
        for (const type of [
          'TICKET_UNDER_REVIEW',
          'TICKET_IN_PROGRESS',
          'TICKET_RESOLVED',
          'TICKET_CLOSED',
          'WARRANTY_ASSESSED',
        ])
          assert.deepEqual(
            (await deliveries(type)).map((d) => d.userId),
            [buyer.id],
          );
        const data = await prepareNotificationEmail('service', creation[0].id);
        assert.ok(data);
        assert.ok(!data.html.includes('<script>'));
        assert.ok(data.html.includes('&lt;script&gt;'));
        for (const secret of [
          'PRIVATE SUBJECT',
          'PRIVATE SERVICE',
          'PRIVATE DIAGNOSIS',
          'PRIVATE PROGRESS',
          'PRIVATE RESOLUTION',
          'PRIVATE COVERAGE',
          'PRIVATE RFQ',
          '98765.43',
          'PRIVATE ADDRESS',
        ]) {
          assert.ok(!JSON.stringify(data).includes(secret), secret);
        }
        const ownIntent = creation.find((d) => d.userId === buyer.id)!;
        assert.ok(
          (await prepareNotificationEmail(
            'service',
            ownIntent.id,
          ))!.text!.includes(`/dashboard/service-tickets/${ticketId}`),
        );
        const adminIntent = creation.find((d) => d.userId === admin.id)!;
        assert.ok(
          (await prepareNotificationEmail(
            'service',
            adminIntent.id,
          ))!.text!.includes(`/dashboard/admin/service-tickets/${ticketId}`),
        );
      },
    );
    await t.test(
      'transaction rollback leaves no event/intents; Redis errors do not fail ticket creation',
      async () => {
        const before = await prisma.notificationEmailDelivery.count();
        await assert.rejects(
          prisma.$transaction(async (tx) => {
            const e = await tx.serviceTicketEvent.create({
              data: {
                ticketId,
                actorId: admin.id,
                type: 'TICKET_UNDER_REVIEW',
              },
            });
            await recordServiceNotifications(
              tx,
              await tx.serviceTicket.findUniqueOrThrow({
                where: { id: ticketId },
              }),
              e,
            );
            throw new Error('Fixture rollback');
          }),
          /Fixture rollback/,
        );
        assert.equal(await prisma.notificationEmailDelivery.count(), before);
        const original = queue.getJob;
        queue.getJob = async () => {
          throw new Error('Redis fixture outage with SECRET CREDENTIAL');
        };
        try {
          const r = await create();
          assert.equal(r.status, 201);
          const d = await prisma.notificationEmailDelivery.findFirstOrThrow({
            where: { event: { ticketId: r.body.data.id }, userId: buyer.id },
          });
          await dispatchDelivery('service', d.id);
          const failed =
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: d.id },
            });
          assert.equal(failed.status, 'FAILED');
          assert.equal(failed.attempts, 1);
          assert.equal(failed.lastError, 'Email dispatch failed');
          assert.equal(
            (
              await prisma.serviceTicket.findUniqueOrThrow({
                where: { id: r.body.data.id },
              })
            ).status,
            'OPEN',
          );
        } finally {
          queue.getJob = original;
        }
      },
    );
    await t.test(
      'concurrent dispatch creates one queue job and recovers interrupted QUEUED intents without overwriting SENT',
      async () => {
        const d = await freshIntent();
        await Promise.all([
          dispatchDelivery('service', d.id),
          dispatchDelivery('service', d.id),
        ]);
        assert.equal(
          (
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: d.id },
            })
          ).attempts,
          1,
        );
        const job = await queue.getJob(d.id);
        assert.ok(job);
        await job.remove();
        await dispatchDelivery('service', d.id);
        assert.ok(await queue.getJob(d.id));
        let calls = 0;
        const provider = {
          send: async () => {
            calls++;
            return { id: 'provider-' + d.id };
          },
        };
        await deliverEmail(
          {
            to: 'attacker@example.test',
            subject: 'FORGED',
            html: 'PRIVATE FORGED HTML',
            notificationDeliveryId: d.id,
          },
          d.id,
          {
            send: async (email) => {
              assert.equal(email.to, `${marker}-0@example.test`);
              assert.ok(!email.html.includes('FORGED'));
              return provider.send();
            },
          },
        );
        await dispatchDelivery('service', d.id);
        await deliverEmail(job.data, d.id, provider);
        assert.equal(calls, 1);
        assert.equal(
          (
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: d.id },
            })
          ).status,
          'SENT',
        );
      },
    );
    await t.test(
      'queue worker retries actual provider failures with one stable key and bounded attempts',
      async () => {
        const d = await freshIntent(),
          payload = await prepareNotificationEmail('service', d.id);
        assert.ok(payload);
        const eventConnection = createRedisConnection('worker'),
          connection = createRedisConnection('worker');
        const events = new QueueEvents(process.env.EMAIL_QUEUE_NAME!, {
          connection: eventConnection,
        });
        const ids: string[] = [];
        const worker = new Worker<EmailJob>(
          process.env.EMAIL_QUEUE_NAME!,
          (job) =>
            deliverEmail(job.data, job.id!, {
              send: async (_email, id) => {
                if (id !== d.id) return { id: 'other-fixture-' + id };
                ids.push(id);
                if (ids.length < 3) throw new Error('SECRET PROVIDER DETAIL');
                return { id: 'accepted-fixture' };
              },
            }),
          { connection },
        );
        try {
          await events.waitUntilReady();
          const job = await queue.add('notification', payload, {
            jobId: d.id,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1 },
            removeOnComplete: false,
          });
          await job.waitUntilFinished(events, 10000);
          assert.deepEqual(ids, [d.id, d.id, d.id]);
          const sent = await prisma.notificationEmailDelivery.findUniqueOrThrow(
            { where: { id: d.id } },
          );
          assert.equal(sent.status, 'SENT');
          assert.equal(sent.sendAttempts, 3);
          assert.equal(sent.providerMessageId, 'accepted-fixture');
          assert.equal(sent.lastError, null);
        } finally {
          await worker.close();
          await events.close();
          await connection.quit();
          await eventConnection.quit();
        }
      },
    );
    await t.test(
      'recipient revocation is checked again at send, and assigned history mail does not require supplier write entitlement',
      async () => {
        const d = await freshIntent();
        await dispatchDelivery('service', d.id);
        await prisma.user.update({
          where: { id: buyer.id },
          data: { isEmailVerified: false },
        });
        let sent = false;
        await deliverEmail((await queue.getJob(d.id))!.data, d.id, {
          send: async () => {
            sent = true;
            return { id: 'forbidden' };
          },
        });
        assert.equal(sent, false);
        assert.equal(
          (
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: d.id },
            })
          ).status,
          'SUPPRESSED',
        );
        await prisma.user.update({
          where: { id: buyer.id },
          data: { isEmailVerified: true },
        });
        const assignment = (await deliveries('TICKET_ASSIGNED')).find(
          (d) => d.userId === next.id,
        )!;
        await prisma.userRoleAssignment.update({
          where: { userId_role: { userId: next.id, role: 'SALES_PERSON' } },
          data: { role: 'LOCAL_SUPPLIER' },
        });
        const retained = await prepareNotificationEmail(
          'service',
          assignment.id,
        );
        assert.ok(retained);
        assert.ok(
          retained.text!.includes(`/dashboard/service-management/${ticketId}`),
        );
        await prisma.user.update({
          where: { id: next.id },
          data: { status: 'SUSPENDED' },
        });
        assert.equal(
          await prepareNotificationEmail('service', assignment.id),
          null,
        );
      },
    );
    await t.test(
      'terminal retries and old ambiguous attempts cannot send indefinitely; accepted job results reconcile without resend',
      async () => {
        const failed = await freshIntent();
        let calls = 0;
        const payload = (await prepareNotificationEmail('service', failed.id))!;
        const provider = {
          send: async () => {
            calls++;
            throw new Error('PRIVATE PROVIDER FAILURE');
          },
        };
        for (let i = 0; i < 6; i++)
          await assert.rejects(deliverEmail(payload, failed.id, provider));
        assert.equal(calls, 5);
        assert.equal(
          (
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: failed.id },
            })
          ).status,
          'FAILED',
        );
        const old = await freshIntent();
        await prisma.notificationEmailDelivery.update({
          where: { id: old.id },
          data: {
            firstAttemptAt: new Date(Date.now() - safeRetryWindowMs - 1000),
            sendAttempts: 1,
          },
        });
        await dispatchDelivery('service', old.id);
        assert.equal(
          (
            await prisma.notificationEmailDelivery.findUniqueOrThrow({
              where: { id: old.id },
            })
          ).status,
          'REVIEW_REQUIRED',
        );
        assert.equal(await queue.getJob(old.id), undefined);
        const completed = await freshIntent(),
          p = (await prepareNotificationEmail('service', completed.id))!;
        const connection = createRedisConnection('worker'),
          eventConnection = createRedisConnection('worker');
        const events = new QueueEvents(process.env.EMAIL_QUEUE_NAME!, {
          connection: eventConnection,
        });
        const worker = new Worker<EmailJob>(
          process.env.EMAIL_QUEUE_NAME!,
          async () => ({ id: 'persisted-queue-result' }),
          { connection },
        );
        try {
          await events.waitUntilReady();
          const job = await queue.add('notification', p, {
            jobId: completed.id,
            removeOnComplete: false,
          });
          await job.waitUntilFinished(events, 10000);
          await dispatchDelivery('service', completed.id);
          const row = await prisma.notificationEmailDelivery.findUniqueOrThrow({
            where: { id: completed.id },
          });
          assert.equal(row.status, 'SENT');
          assert.equal(row.providerMessageId, 'persisted-queue-result');
          assert.equal(row.sendAttempts, 0);
        } finally {
          await worker.close();
          await events.close();
          await connection.quit();
          await eventConnection.quit();
        }
      },
    );
    await t.test(
      'existing RFQ intents use the shared queue safely and do not expose private content',
      async () => {
        const event = await prisma.rfqEvent.create({
          data: {
            rfqId: purchase.rfq.id,
            eventType: 'MESSAGE_SENT',
            metadata: {},
          },
        });
        const d = await prisma.rfqEmailDelivery.create({
          data: { eventId: event.id, userId: buyer.id },
        });
        await dispatchDelivery('rfq', d.id);
        const job = await queue.getJob(d.id);
        assert.ok(job);
        assert.ok(
          job.data.text!.includes(`/dashboard/rfqs/${purchase.rfq.id}`),
        );
        assert.ok(!JSON.stringify(job.data).includes('PRIVATE RFQ TEXT'));
        await deliverEmail(job.data, d.id, {
          send: async () => ({ id: 'rfq-fixture' }),
        });
        const sent = await prisma.rfqEmailDelivery.findUniqueOrThrow({
          where: { id: d.id },
        });
        assert.equal(sent.status, 'SENT');
        assert.equal(sent.providerMessageId, 'rfq-fixture');
        await prisma.rfqRecipient.update({
          where: { id: purchase.recipient.id },
          data: { removedAt: new Date() },
        });
        const removed = await prisma.rfqEmailDelivery.create({
          data: { eventId: event.id, userId: agent.id },
        });
        assert.equal(await prepareNotificationEmail('rfq', removed.id), null);
      },
    );
    await t.test(
      'authentication payload compatibility, plain-text links and template HTML safety are preserved',
      async () => {
        const auth = {
          to: 'fixture@example.test',
          subject: 'Verify',
          html: '<p>Verification</p>',
          text: authEmailText(
            'Fixture',
            'Verify',
            'https://example.test/auth/verify-user?token=fixture',
          ),
        };
        assert.deepEqual(
          await deliverEmail(auth, randomUUID(), {
            send: async (email) => {
              assert.deepEqual(email, auth);
              return { id: 'auth-fixture' };
            },
          }),
          { id: 'auth-fixture' },
        );
        const template = serviceEmail(
          '<img src=x onerror=alert(1)>',
          'SVC-000123',
          'TICKET_RESOLVED',
          'https://example.test/dashboard/service-tickets/uuid?a=1&b=2',
        );
        assert.ok(template);
        assert.ok(template.html.includes('&lt;img'));
        assert.ok(!template.html.includes('<img'));
        assert.ok(template.text.includes('SVC-000123'));
        assert.ok(template.text.includes('?a=1&b=2'));
        assert.equal(
          serviceEmail(
            'Name',
            'SVC-000123',
            'SERVICE_PROGRESS',
            'https://example.test',
          ),
          null,
        );
        assert.equal(
          serviceEmail(
            'Name',
            'SVC-000123',
            '__proto__',
            'https://example.test',
          ),
          null,
        );
        assert.ok(
          rfqEmailText(
            'Name',
            'RFQ-1',
            'SUBMITTED',
            'https://example.test',
          ).includes('RFQ-1'),
        );
      },
    );
  } finally {
    await queue.obliterate({ force: true });
    await closeEmailQueue();
    await cleanTicketFixtures(users, categoryId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
});
