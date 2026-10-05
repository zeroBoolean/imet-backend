import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { expireRfqs } from '../src/modules/rfq/rfq.jobs.js';
import { config } from '../src/config/env.js';
import { validateAttachment } from '../src/modules/rfq/rfqAttachment.service.js';
import type { UserRole } from '../src/generated/client.js';

test('attachments reject disguised executable content and oversized files', async () => {
  await assert.rejects(
    validateAttachment(Buffer.from('<script>bad()</script>')),
  );
  await assert.rejects(validateAttachment(Buffer.alloc(10 * 1024 * 1024 + 1)));
  assert.equal(
    (await validateAttachment(Buffer.from('%PDF-1.7\nfixture'))).mime,
    'application/pdf',
  );
});

test('RFQ routing, privacy, caps, quote races, messages, contact gating, expiry and audit', async () => {
  const marker = `rfq-test-${randomUUID()}`;
  const users: string[] = [];
  const rfqs: string[] = [];
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/api/v1`;
  const req = async (
    path: string,
    token?: string,
    method = 'GET',
    body?: unknown,
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const account = async (role: UserRole) => {
    const u = await prisma.user.create({
      data: {
        email: `${marker}-${users.length}@example.test`,
        displayName: marker,
        password: 'unusable fixture',
        status: 'ACTIVE',
        isEmailVerified: true,
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
  let planId: string | undefined;
  try {
    const buyer = await account('BUYER'),
      stranger = await account('BUYER'),
      admin = await account('ADMIN'),
      supplier = await account('LOCAL_SUPPLIER'),
      competitor = await account('LOCAL_SUPPLIER');
    const category = await prisma.machineCategory.create({
      data: { name: marker, slug: marker },
    });
    categoryId = category.id;
    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: marker,
        eligibleTypes: ['LOCAL'],
        durationDays: 30,
        price: '10',
        currency: 'USD',
        listingLimit: 10,
        imageLimit: 0,
        specificationLimit: 0,
        canPublishMachinery: true,
        visibility: 'STANDARD',
        rfqEnabled: true,
        leadLimitPerMonth: 1,
        canRevealContacts: true,
      },
    });
    planId = plan.id;
    for (const user of [supplier, competitor]) {
      const s = await prisma.supplier.create({
        data: {
          userId: user.id,
          companyName: marker + user.id,
          type: 'LOCAL',
          description: 'Company',
          contactName: 'Private Name',
          businessEmail: `private-${user.id}@example.test`,
          businessPhone: '+880123456',
          address: 'Private address',
          city: 'Dhaka',
          country: 'Bangladesh',
          documents: [],
          status: 'APPROVED',
          isVerified: true,
          marketplaceVisible: true,
        },
      });
      await prisma.supplierSubscription.create({
        data: {
          supplierId: s.id,
          planId: plan.id,
          planName: plan.name,
          supplierType: 'LOCAL',
          durationDays: 30,
          price: '10',
          currency: 'USD',
          listingLimit: 10,
          imageLimit: 0,
          specificationLimit: 0,
          canPublishMachinery: true,
          visibility: 'STANDARD',
          rfqEnabled: true,
          leadLimitPerMonth: 1,
          canRevealContacts: true,
          state: 'ACTIVE',
          startsAt: new Date(Date.now() - 60000),
          endsAt: new Date(Date.now() + 86400000),
        },
      });
      await prisma.machine.create({
        data: {
          name: marker,
          slug: marker + user.id,
          description: 'Machine',
          manufacturer: 'Fixture',
          model: 'Fixture',
          categoryId: category.id,
          supplierId: s.id,
          status: 'PUBLISHED',
        },
      });
    }
    const input = {
      machineId: null,
      categoryId: category.id,
      title: marker,
      description: 'Technical requirements',
      quantity: '2',
      unit: 'units',
      targetBudget: '2000',
      budgetCurrency: 'USD',
      deliveryLocation: 'Dhaka',
      deliveryTimeline: 'Within 30 days',
      supplierCountry: 'Bangladesh',
      preferredLanguage: 'en',
    };
    assert.equal((await req('/rfqs', undefined, 'POST', input)).status, 401);
    assert.equal(
      (await req('/rfqs', supplier.token, 'POST', input)).status,
      403,
    );
    assert.equal(
      (
        await req('/rfqs', buyer.token, 'POST', {
          ...input,
          status: 'ACCEPTED',
        })
      ).status,
      422,
    );
    const created = await req('/rfqs', buyer.token, 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created));
    const r = created.body.data;
    rfqs.push(r.id);
    assert.match(r.rfqNumber, /^RFQ-\d{4}-\d+$/);
    assert.equal((await req(`/rfqs/${r.id}`, stranger.token)).status, 404);
    assert.equal(
      (
        await req(`/rfqs/${r.id}/submit`, buyer.token, 'POST', {
          updatedAt: r.updatedAt,
        })
      ).status,
      200,
    );
    let detail = (await req(`/rfqs/${r.id}`, buyer.token)).body.data;
    assert.equal(detail.status, 'ROUTED');
    assert.equal(detail.recipients.length, 2);
    assert.equal(detail.targetBudget, '2000');
    assert.equal(detail.recipients[0].contact, null);
    const sd = (await req(`/rfqs/${r.id}`, supplier.token)).body.data;
    assert.equal(sd.recipients.length, 1);
    assert.ok(!('targetBudget' in sd));
    assert.ok(!JSON.stringify(sd).includes('Private address'));
    const lead = sd.recipients[0];
    assert.equal(
      (await req(`/leads/${lead.id}/viewed`, supplier.token, 'POST')).status,
      200,
    );
    const message = await req(`/rfqs/${r.id}/messages`, buyer.token, 'POST', {
      recipientId: lead.id,
      body: 'Private thread',
    });
    assert.equal(message.status, 201);
    assert.equal(
      (
        await req(
          `/rfqs/${r.id}/messages?recipientId=${lead.id}`,
          competitor.token,
        )
      ).status,
      404,
    );
    await req(`/rfqs/${r.id}/messages?recipientId=${lead.id}`, admin.token);
    assert.equal(
      (
        await prisma.rfqMessage.findUniqueOrThrow({
          where: { id: message.body.data.id },
        })
      ).readAt,
      null,
    );
    await req(`/rfqs/${r.id}/messages?recipientId=${lead.id}`, supplier.token);
    assert.ok(
      (
        await prisma.rfqMessage.findUniqueOrThrow({
          where: { id: message.body.data.id },
        })
      ).readAt,
    );
    const qi = {
      unitPrice: '100',
      currency: 'USD',
      moq: '1',
      leadTimeDays: 10,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      notes: 'Private offer',
    };
    const q1 = await req(`/rfqs/${r.id}/quotes`, supplier.token, 'POST', qi);
    assert.equal(q1.status, 201, JSON.stringify(q1));
    const q2 = await req(`/rfqs/${r.id}/quotes`, competitor.token, 'POST', {
      ...qi,
      unitPrice: '95',
    });
    assert.equal(q2.status, 201);
    const privateView = (await req(`/rfqs/${r.id}`, supplier.token)).body.data;
    assert.equal(privateView.recipients.length, 1);
    assert.equal(privateView.recipients[0].quotes.length, 1);
    assert.equal(privateView.recipients[0].quotes[0].id, q1.body.data.id);
    // One RFQ may have only one winner, including concurrent acceptance requests.
    const accepts = await Promise.all(
      [q1, q2].map((q) =>
        req(`/quotes/${q.body.data.id}/accept`, buyer.token, 'POST', {
          updatedAt: q.body.data.updatedAt,
        }),
      ),
    );
    assert.deepEqual(accepts.map((a) => a.status).sort(), [200, 409]);
    assert.equal(
      await prisma.rfqQuote.count({
        where: { rfqId: r.id, status: 'ACCEPTED' },
      }),
      1,
    );
    detail = (await req(`/rfqs/${r.id}`, buyer.token)).body.data;
    assert.equal(detail.status, 'ACCEPTED');
    assert.equal(
      detail.recipients.filter((x: { contact: unknown }) => x.contact).length,
      1,
    );
    const winner = detail.recipients.find(
      (x: { contact: unknown }) => x.contact,
    );
    await prisma.supplier.update({
      where: { userId: winner.recipientId },
      data: { contactBlocked: true },
    });
    assert.equal(
      (await req(`/rfqs/${r.id}`, buyer.token)).body.data.recipients.find(
        (x: { id: string }) => x.id === winner.id,
      ).contact,
      null,
    );
    await prisma.supplier.update({
      where: { userId: winner.recipientId },
      data: { contactBlocked: false },
    });
    assert.equal(
      (
        await req(`/rfqs/${r.id}/close`, buyer.token, 'POST', {
          updatedAt: detail.updatedAt,
        })
      ).status,
      200,
    );
    // Both suppliers exhausted their one-lead cap. The next RFQ remains unmatched.
    const capped = (await req('/rfqs', buyer.token, 'POST', input)).body.data;
    rfqs.push(capped.id);
    assert.equal(
      (
        await req(`/rfqs/${capped.id}/submit`, buyer.token, 'POST', {
          updatedAt: capped.updatedAt,
        })
      ).status,
      200,
    );
    const cappedDetail = (await req(`/rfqs/${capped.id}`, buyer.token)).body
      .data;
    assert.equal(
      cappedDetail.recipients.filter(
        (x: { recipientRole: string }) => x.recipientRole !== 'SALESPERSON',
      ).length,
      0,
    );
    const expiry = new Date(Date.now() - 1000);
    await prisma.rfq.update({
      where: { id: capped.id },
      data: { expiresAt: expiry },
    });
    await expireRfqs();
    assert.equal(
      (await prisma.rfq.findUniqueOrThrow({ where: { id: capped.id } })).status,
      'EXPIRED',
    );
    const count = await prisma.rfqEvent.count({
      where: { rfqId: capped.id, eventType: 'EXPIRED' },
    });
    await expireRfqs();
    assert.equal(
      await prisma.rfqEvent.count({
        where: { rfqId: capped.id, eventType: 'EXPIRED' },
      }),
      count,
    );
    const events = await prisma.rfqEvent.findMany({ where: { rfqId: r.id } });
    for (const name of [
      'CREATED',
      'SUBMITTED',
      'ROUTED',
      'QUOTE_CREATED',
      'ACCEPTED',
      'CLOSED',
    ])
      assert.ok(
        events.some((e) => e.eventType === name),
        name,
      );
    assert.ok(
      await prisma.rfqEmailDelivery.count({
        where: { event: { rfqId: r.id } },
      }),
    );
    assert.equal((await req('/admin/rfqs', buyer.token)).status, 403);
    assert.equal((await req('/admin/rfqs', admin.token)).status, 200);
    // A supplier row lock makes monthly allocation safe across two simultaneous RFQs.
    await prisma.supplierSubscription.updateMany({
      where: { supplier: { userId: supplier.id }, isCurrent: true },
      data: { leadLimitPerMonth: 2 },
    });
    const racing = [];
    for (let i = 0; i < 2; i++) {
      const draft = (await req('/rfqs', buyer.token, 'POST', input)).body.data;
      rfqs.push(draft.id);
      racing.push(draft);
    }
    const routed = await Promise.all(
      racing.map((d) =>
        req(`/rfqs/${d.id}/submit`, buyer.token, 'POST', {
          updatedAt: d.updatedAt,
        }),
      ),
    );
    assert.ok(routed.every((x) => x.status === 200));
    assert.equal(
      await prisma.rfqRecipient.count({
        where: {
          rfqId: { in: racing.map((d) => d.id) },
          recipientId: supplier.id,
        },
      }),
      1,
    );
    for (const draft of racing) {
      const latest = (await req(`/rfqs/${draft.id}`, admin.token)).body.data;
      assert.equal(
        (
          await req(`/admin/rfqs/${draft.id}/close`, admin.token, 'POST', {
            updatedAt: latest.updatedAt,
          })
        ).status,
        200,
      );
    }

    // Unmatched RFQs go to sales staff; only assigned staff can route additional recipients.
    const sales = await account('SALES_PERSON');
    const manual = (
      await req('/rfqs', buyer.token, 'POST', { ...input, categoryId: null })
    ).body.data;
    rfqs.push(manual.id);
    assert.equal(
      (
        await req(`/rfqs/${manual.id}/submit`, buyer.token, 'POST', {
          updatedAt: manual.updatedAt,
        })
      ).status,
      200,
    );
    let md = (await req(`/rfqs/${manual.id}`, buyer.token)).body.data;
    assert.ok(
      md.recipients.some(
        (x: { recipientId: string }) => x.recipientId === sales.id,
      ),
    );
    await prisma.supplierSubscription.updateMany({
      where: { supplier: { userId: supplier.id }, isCurrent: true },
      data: { leadLimitPerMonth: 5 },
    });
    assert.equal(
      (
        await req(`/rfqs/${manual.id}/recipients`, sales.token, 'POST', {
          updatedAt: md.updatedAt,
          userIds: [supplier.id],
          action: 'ADD',
        })
      ).status,
      200,
    );
    md = (await req(`/rfqs/${manual.id}`, admin.token)).body.data;
    assert.equal(
      (
        await req(`/admin/rfqs/${manual.id}/flag`, admin.token, 'POST', {
          updatedAt: md.updatedAt,
          isFlagged: true,
          reason: 'Review required',
          blockSupplierContact: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await req(`/rfqs/${manual.id}/quotes`, supplier.token, 'POST', qi))
        .status,
      409,
    );
    md = (await req(`/rfqs/${manual.id}`, admin.token)).body.data;
    assert.equal(
      (
        await req(`/admin/rfqs/${manual.id}/flag`, admin.token, 'POST', {
          updatedAt: md.updatedAt,
          isFlagged: false,
          reason: 'Review cleared',
          blockSupplierContact: true,
        })
      ).status,
      200,
    );
    const removable = (
      await req(`/rfqs/${manual.id}/quotes`, supplier.token, 'POST', qi)
    ).body.data;
    md = (await req(`/rfqs/${manual.id}`, admin.token)).body.data;
    const archivedLead = md.recipients.find(
      (x: { recipientId: string }) => x.recipientId === supplier.id,
    );
    assert.equal(
      (
        await req(`/rfqs/${manual.id}/messages`, buyer.token, 'POST', {
          recipientId: archivedLead.id,
          body: 'Retained private history',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await req(`/admin/rfqs/${manual.id}/recipients`, admin.token, 'POST', {
          updatedAt: md.updatedAt,
          userIds: [supplier.id],
          action: 'REMOVE',
        })
      ).status,
      200,
    );
    assert.equal(
      (await prisma.rfqQuote.findUniqueOrThrow({ where: { id: removable.id } }))
        .status,
      'WITHDRAWN',
    );
    assert.ok(
      await prisma.rfqEvent.count({
        where: { rfqId: manual.id, eventType: 'QUOTE_WITHDRAWN' },
      }),
    );
    assert.equal(
      (
        await req(
          `/rfqs/${manual.id}/messages?recipientId=${archivedLead.id}`,
          admin.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          `/rfqs/${manual.id}/messages?recipientId=${archivedLead.id}`,
          supplier.token,
        )
      ).status,
      404,
    );
    const overview = await req(`/admin/leads?limit=1&q=${marker}`, admin.token);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.data.suppliers.length, 1);
    assert.equal(overview.body.data.pagination.total, 2);
    // Reminder markers prevent duplicate reminders across worker ticks.
    await prisma.rfq.update({
      where: { id: manual.id },
      data: { expiresAt: new Date(Date.now() + 86400000) },
    });
    await expireRfqs();
    const reminders = await prisma.rfqEvent.count({
      where: { rfqId: manual.id, eventType: 'EXPIRY_REMINDER' },
    });
    assert.ok(reminders);
    await expireRfqs();
    assert.equal(
      await prisma.rfqEvent.count({
        where: { rfqId: manual.id, eventType: 'EXPIRY_REMINDER' },
      }),
      reminders,
    );
    const declined = (await req('/rfqs', buyer.token, 'POST', input)).body.data;
    rfqs.push(declined.id);
    assert.equal(
      (
        await req(`/rfqs/${declined.id}/submit`, buyer.token, 'POST', {
          updatedAt: declined.updatedAt,
        })
      ).status,
      200,
    );
    const ownDeclinedLead = (await req(`/rfqs/${declined.id}`, supplier.token))
      .body.data.recipients[0];
    assert.equal(
      (
        await req(
          `/leads/${ownDeclinedLead.id}/decline`,
          supplier.token,
          'POST',
        )
      ).status,
      200,
    );
    const allDeclined = (await req(`/rfqs/${declined.id}`, admin.token)).body
      .data;
    assert.equal(allDeclined.status, 'DECLINED');
    assert.equal(
      (
        await req(`/admin/rfqs/${declined.id}/reroute`, admin.token, 'POST', {
          updatedAt: allDeclined.updatedAt,
        })
      ).body.data.status,
      'DECLINED',
    );
    // Private storage is exercised with an HTTP mock, never with a live Bunny key.
    const attachmentDraft = (await req('/rfqs', buyer.token, 'POST', input))
      .body.data;
    rfqs.push(attachmentDraft.id);
    const originalFetch = globalThis.fetch;
    const oldZone = config.BUNNY_STORAGE_ZONE,
      oldKey = config.BUNNY_STORAGE_ACCESS_KEY;
    config.BUNNY_STORAGE_ZONE = 'fixture';
    config.BUNNY_STORAGE_ACCESS_KEY = 'fixture-not-a-real-key';
    const stored = new Map<string, Uint8Array>();
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://storage.bunnycdn.com/fixture/')) {
        assert.equal(
          new Headers(options?.headers).get('AccessKey'),
          'fixture-not-a-real-key',
        );
        const key = String(url);
        if (options?.method === 'PUT') {
          stored.set(key, options.body as Uint8Array);
          return new Response(null, { status: 201 });
        }
        if (options?.method === 'DELETE') {
          stored.delete(key);
          return new Response(null, { status: 200 });
        }
        return new Response(stored.get(key), { status: 200 });
      }
      return originalFetch(url, options);
    };
    try {
      const form = new FormData();
      form.set(
        'file',
        new Blob(['%PDF-1.7\nprivate test'], { type: 'application/pdf' }),
        'requirements.pdf',
      );
      const response = await originalFetch(
        `${base}/rfqs/${attachmentDraft.id}/attachments`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${buyer.token}` },
          body: form,
        },
      );
      assert.equal(response.status, 201);
      const file = (await response.json()).data;
      assert.ok(!('storageKey' in file));
      assert.equal(
        (await req(`/rfq-attachments/${file.id}`, stranger.token)).status,
        404,
      );
      const download = await originalFetch(
        `${base}/rfq-attachments/${file.id}`,
        { headers: { Authorization: `Bearer ${buyer.token}` } },
      );
      assert.equal(download.status, 200);
      assert.equal(await download.text(), '%PDF-1.7\nprivate test');
      assert.equal(download.headers.get('cache-control'), 'private, no-store');
    } finally {
      globalThis.fetch = originalFetch;
      config.BUNNY_STORAGE_ZONE = oldZone;
      config.BUNNY_STORAGE_ACCESS_KEY = oldKey;
    }
  } catch (error) {
    console.error('RFQ test failure', error);
    throw error;
  } finally {
    try {
      await prisma.salesEvent.deleteMany({
        where: { opportunity: { recipient: { rfqId: { in: rfqs } } } },
      });
      await prisma.saleRecord.deleteMany({
        where: { opportunity: { recipient: { rfqId: { in: rfqs } } } },
      });
      await prisma.salesOpportunity.deleteMany({
        where: { recipient: { rfqId: { in: rfqs } } },
      });
      await prisma.rfqEmailDelivery.deleteMany({
        where: { event: { rfqId: { in: rfqs } } },
      });
      await prisma.rfqEvent.deleteMany({ where: { rfqId: { in: rfqs } } });
      await prisma.rfqMessage.deleteMany({ where: { rfqId: { in: rfqs } } });
      await prisma.rfqQuoteAttachment.deleteMany({
        where: { quote: { rfqId: { in: rfqs } } },
      });
      await prisma.rfqQuote.deleteMany({ where: { rfqId: { in: rfqs } } });
      await prisma.rfqAttachment.deleteMany({ where: { rfqId: { in: rfqs } } });
      await prisma.rfqRecipient.deleteMany({ where: { rfqId: { in: rfqs } } });
      await prisma.rfq.deleteMany({ where: { id: { in: rfqs } } });
      await prisma.machine.deleteMany({
        where: { supplier: { userId: { in: users } } },
      });
      await prisma.supplierSubscription.deleteMany({
        where: { supplier: { userId: { in: users } } },
      });
      await prisma.supplier.deleteMany({ where: { userId: { in: users } } });
      if (planId)
        await prisma.subscriptionPlan.delete({ where: { id: planId } });
      if (categoryId)
        await prisma.machineCategory.delete({ where: { id: categoryId } });
      await prisma.userSession.deleteMany({ where: { userId: { in: users } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await disconnectDatabase();
    }
  }
});
