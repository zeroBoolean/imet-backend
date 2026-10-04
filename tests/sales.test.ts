import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { expireRfqs } from '../src/modules/rfq/rfq.jobs.js';
import type { UserRole } from '../src/generated/client.js';

// Integration tests exercise the existing M5 HTTP flow, not synthetic sales stages.
test('M6 sales lifecycle, privacy, entitlements and concurrency', async (t) => {
  const marker = `sales-test-${randomUUID()}`;
  const users: string[] = [],
    rfqs: string[] = [];
  let categoryId: string | undefined, planId: string | undefined;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
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
  const ok = async (
    path: string,
    token: string,
    method = 'GET',
    body?: unknown,
    status = 200,
  ) => {
    const r = await req(path, token, method, body);
    assert.equal(r.status, status, JSON.stringify(r));
    return r.body.data;
  };
  const account = async (roles: UserRole[]) => {
    const u = await prisma.user.create({
      data: {
        email: `${marker}-${users.length}@example.test`,
        displayName: marker,
        password: 'unusable fixture',
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { create: roles.map((role) => ({ role })) },
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
  try {
    const buyer = await account(['BUYER']),
      stranger = await account(['BUYER']),
      admin = await account(['ADMIN']),
      supplier = await account(['LOCAL_SUPPLIER', 'INDEPENDENT_SELLER']),
      competitor = await account(['LOCAL_SUPPLIER']),
      salesperson = await account(['SALES_PERSON']);
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
        leadLimitPerMonth: null,
        canRevealContacts: false,
      },
    });
    planId = plan.id;
    const terms: string[] = [];
    for (const user of [supplier, competitor]) {
      const s = await prisma.supplier.create({
        data: {
          userId: user.id,
          companyName: marker + user.id,
          type: 'LOCAL',
          description: 'Company',
          contactName: 'SECRET CONTACT',
          businessEmail: `secret-${user.id}@example.test`,
          businessPhone: '+880123456',
          address: 'SECRET ADDRESS',
          city: 'Dhaka',
          country: 'Bangladesh',
          documents: [],
          status: 'APPROVED',
          isVerified: true,
          marketplaceVisible: true,
        },
      });
      const term = await prisma.supplierSubscription.create({
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
          leadLimitPerMonth: null,
          canRevealContacts: false,
          state: 'ACTIVE',
          startsAt: new Date(Date.now() - 60000),
          endsAt: new Date(Date.now() + 86400000),
        },
      });
      terms.push(term.id);
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
    const quoteInput = {
      unitPrice: '123.45',
      currency: 'USD',
      moq: '1',
      leadTimeDays: 7,
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      notes: 'Commercial offer',
    };
    const submit = async (quantity = '2') => {
      const draft = await ok(
        '/rfqs',
        buyer.token,
        'POST',
        { ...input, quantity },
        201,
      );
      rfqs.push(draft.id);
      await ok(`/rfqs/${draft.id}/submit`, buyer.token, 'POST', {
        updatedAt: draft.updatedAt,
      });
      const opp = await prisma.salesOpportunity.findFirstOrThrow({
        where: { recipient: { rfqId: draft.id, recipientId: supplier.id } },
      });
      return { id: draft.id, opp: opp.id };
    };
    const detail = (id: string, token = supplier.token) =>
      ok(`/sales/opportunities/${id}`, token);
    let main = { id: '', opp: '' },
      saleId = '';
    await t.test(
      'M5 submission creates exactly one private opportunity per assigned recipient',
      async () => {
        main = await submit();
        const own = await detail(main.opp);
        assert.equal(own.stage, 'NEW');
        assert.equal(own.canEdit, true);
        assert.equal(
          await prisma.salesOpportunity.count({
            where: { recipient: { rfqId: main.id } },
          }),
          2,
        );
        assert.equal((await req('/sales/opportunities')).status, 401);
        assert.equal(
          (await req(`/sales/opportunities/${main.opp}`, buyer.token)).status,
          403,
        );
        assert.equal(
          (await req(`/sales/opportunities/${main.opp}`, competitor.token))
            .status,
          404,
        );
        assert.equal(
          (await req('/admin/sales/opportunities', supplier.token)).status,
          403,
        );
        assert.equal(
          (await req('/sales/opportunities/not-a-uuid', supplier.token)).status,
          422,
        );
        const list = await ok(
          `/sales/opportunities?q=${marker}&limit=1`,
          supplier.token,
        );
        assert.equal(list.opportunities.length, 1);
        assert.equal(list.pagination.total, 1);
        assert.equal(list.counts.NEW, 1);
        assert.ok(!JSON.stringify(own).includes('targetBudget'));
        assert.ok(!JSON.stringify(own).includes('SECRET CONTACT'));
        await prisma.user.update({
          where: { id: supplier.id },
          data: { status: 'SUSPENDED' },
        });
        assert.equal(
          (await req(`/sales/opportunities/${main.opp}`, supplier.token))
            .status,
          403,
        );
        await prisma.user.update({
          where: { id: supplier.id },
          data: { status: 'ACTIVE' },
        });
      },
    );
    await t.test(
      'qualification, notes privacy, strict validation and optimistic concurrency',
      async () => {
        const old = await detail(main.opp);
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}`,
              supplier.token,
              'PATCH',
              { updatedAt: old.updatedAt, stage: 'WON' },
            )
          ).status,
          422,
        );
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}`,
              supplier.token,
              'PATCH',
              { updatedAt: old.updatedAt, stage: 'NEGOTIATION' },
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}`,
              supplier.token,
              'PATCH',
              { updatedAt: old.updatedAt, internalNotes: 'x'.repeat(5001) },
            )
          ).status,
          422,
        );
        const mutations = await Promise.all(
          ['A', 'B'].map((n) =>
            req(`/sales/opportunities/${main.opp}`, supplier.token, 'PATCH', {
              updatedAt: old.updatedAt,
              stage: 'QUALIFIED',
              internalNotes: `PRIVATE ${n}`,
            }),
          ),
        );
        assert.deepEqual(mutations.map((r) => r.status).sort(), [200, 409]);
        const own = await detail(main.opp);
        assert.equal(own.stage, 'QUALIFIED');
        assert.match(own.internalNotes, /^PRIVATE/);
        assert.equal(
          (await detail(main.opp, admin.token)).internalNotes,
          own.internalNotes,
        );
        assert.ok(
          !JSON.stringify(await ok(`/rfqs/${main.id}`, buyer.token)).includes(
            'PRIVATE',
          ),
        );
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}/record-sale`,
              supplier.token,
              'POST',
              { updatedAt: own.updatedAt },
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'existing quote submission and acceptance drive stages; competing quotes stay private',
      async () => {
        const q = await ok(
          `/rfqs/${main.id}/quotes`,
          supplier.token,
          'POST',
          quoteInput,
          201,
        );
        const other = await ok(
          `/rfqs/${main.id}/quotes`,
          competitor.token,
          'POST',
          { ...quoteInput, unitPrice: '444' },
          201,
        );
        let own = await detail(main.opp);
        assert.equal(own.stage, 'QUOTED');
        assert.equal(own.quotes.length, 1);
        assert.equal(own.quotes[0].id, q.id);
        assert.ok(!JSON.stringify(own).includes(other.id));
        await ok(`/sales/opportunities/${main.opp}`, supplier.token, 'PATCH', {
          updatedAt: own.updatedAt,
          stage: 'NEGOTIATION',
        });
        own = await detail(main.opp);
        assert.equal(own.stage, 'NEGOTIATION');
        await ok(`/quotes/${q.id}/accept`, buyer.token, 'POST', {
          updatedAt: q.updatedAt,
        });
        own = await detail(main.opp);
        assert.equal(own.stage, 'WON');
        assert.equal(own.sale, null);
        const loser = await prisma.salesOpportunity.findFirstOrThrow({
          where: { recipient: { rfqId: main.id, recipientId: competitor.id } },
        });
        assert.equal(loser.stage, 'LOST');
        assert.equal(
          (
            await req(
              `/sales/opportunities/${loser.id}/record-sale`,
              competitor.token,
              'POST',
              { updatedAt: loser.updatedAt.toISOString() },
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}`,
              supplier.token,
              'PATCH',
              { updatedAt: own.updatedAt, stage: 'QUALIFIED' },
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'manual recording is idempotent under races; buyer sees accepted commercial terms only',
      async () => {
        const own = await detail(main.opp);
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}/record-sale`,
              buyer.token,
              'POST',
              { updatedAt: own.updatedAt },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await req(
              `/sales/opportunities/${main.opp}/record-sale`,
              supplier.token,
              'POST',
              { updatedAt: own.updatedAt, unitPrice: '1' },
            )
          ).status,
          422,
        );
        const races = await Promise.all(
          [supplier.token, admin.token].map((token) =>
            req(`/sales/opportunities/${main.opp}/record-sale`, token, 'POST', {
              updatedAt: own.updatedAt,
            }),
          ),
        );
        assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
        saleId = races.find((r) => r.status === 201)!.body.data.id;
        const sale = await ok(`/sales/records/${saleId}`, buyer.token);
        assert.equal(sale.totalAmount, '246.9');
        assert.equal(sale.quote.unitPrice, '123.45');
        assert.equal(sale.canEdit, false);
        for (const secret of [
          'internalNotes',
          'PRIVATE',
          'targetBudget',
          'businessEmail',
          'SECRET CONTACT',
          'events',
        ])
          assert.ok(!JSON.stringify(sale).includes(secret));
        assert.equal(
          (await req(`/sales/records/${saleId}`, stranger.token)).status,
          404,
        );
        assert.equal(
          (await req(`/sales/records/${saleId}`, competitor.token)).status,
          404,
        );
        assert.equal(
          (
            await req(`/sales/records/${saleId}`, buyer.token, 'PATCH', {
              updatedAt: sale.updatedAt,
              status: 'COMPLETED',
            })
          ).status,
          403,
        );
        assert.equal(
          (await ok(`/sales/records?view=buyer&q=${marker}`, buyer.token))
            .pagination.total,
          1,
        );
        assert.equal(
          (await ok(`/sales/records?view=buyer&q=${marker}`, stranger.token))
            .pagination.total,
          0,
        );
        assert.equal(
          (await ok(`/sales/records?q=${marker}`, competitor.token)).pagination
            .total,
          0,
        );
        assert.equal(
          (await ok(`/admin/sales/records?q=${marker}`, admin.token)).pagination
            .total,
          1,
        );
      },
    );
    await t.test(
      'expired, suspended and disabled RFQ terms permit reads but reject mutations; admins remain exempt',
      async () => {
        for (const patch of [
          { endsAt: new Date(Date.now() - 1000) },
          { state: 'SUSPENDED' as const },
          { rfqEnabled: false },
        ]) {
          await prisma.supplierSubscription.update({
            where: { id: terms[0] },
            data: {
              state: 'ACTIVE',
              endsAt: new Date(Date.now() + 86400000),
              rfqEnabled: true,
              ...patch,
            },
          });
          const own = await detail(main.opp),
            sale = await ok(`/sales/records/${saleId}`, supplier.token);
          assert.equal(own.canEdit, false);
          assert.equal(sale.canEdit, false);
          assert.ok(own.readOnlyReason);
          assert.equal(
            (
              await req(
                `/sales/opportunities/${main.opp}`,
                supplier.token,
                'PATCH',
                { updatedAt: own.updatedAt, internalNotes: 'blocked' },
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await req(`/sales/records/${saleId}`, supplier.token, 'PATCH', {
                updatedAt: sale.updatedAt,
                status: 'COMPLETED',
              })
            ).status,
            403,
          );
        }
        const own = await detail(main.opp, admin.token);
        assert.equal(own.canEdit, true);
        await ok(`/sales/opportunities/${main.opp}`, admin.token, 'PATCH', {
          updatedAt: own.updatedAt,
          internalNotes: 'PRIVATE ADMIN',
        });
        await prisma.supplierSubscription.update({
          where: { id: terms[0] },
          data: {
            state: 'ACTIVE',
            endsAt: new Date(Date.now() + 86400000),
            rfqEnabled: true,
          },
        });
        assert.equal((await detail(main.opp)).canEdit, true);
      },
    );
    await t.test(
      'sale completion is final and stale competing cancellation cannot overwrite it',
      async () => {
        const sale = await ok(`/sales/records/${saleId}`, supplier.token);
        assert.equal(
          (
            await req(`/sales/records/${saleId}`, supplier.token, 'PATCH', {
              updatedAt: sale.updatedAt,
              status: 'CANCELLED',
            })
          ).status,
          422,
        );
        const races = await Promise.all([
          req(`/sales/records/${saleId}`, supplier.token, 'PATCH', {
            updatedAt: sale.updatedAt,
            status: 'COMPLETED',
          }),
          req(`/sales/records/${saleId}`, admin.token, 'PATCH', {
            updatedAt: sale.updatedAt,
            status: 'COMPLETED',
          }),
        ]);
        assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
        const completed = await ok(`/sales/records/${saleId}`, buyer.token);
        assert.equal(completed.status, 'COMPLETED');
        assert.ok(completed.completedAt);
        assert.equal(completed.cancelledAt, null);
        assert.equal(
          (
            await req(`/sales/records/${saleId}`, supplier.token, 'PATCH', {
              updatedAt: completed.updatedAt,
              status: 'CANCELLED',
              reason: 'Too late',
            })
          ).status,
          409,
        );
        assert.equal((await detail(main.opp)).stage, 'WON');
      },
    );
    await t.test(
      'new sale cancellation preserves accepted pricing and exact large decimal totals',
      async () => {
        const r = await submit('999999999.999');
        const q = await ok(
          `/rfqs/${r.id}/quotes`,
          supplier.token,
          'POST',
          { ...quoteInput, unitPrice: '999999999999.99' },
          201,
        );
        await ok(`/quotes/${q.id}/accept`, buyer.token, 'POST', {
          updatedAt: q.updatedAt,
        });
        const own = await detail(r.opp);
        const record = await ok(
          `/sales/opportunities/${r.opp}/record-sale`,
          admin.token,
          'POST',
          { updatedAt: own.updatedAt },
          201,
        );
        const sale = await ok(`/sales/records/${record.id}`, buyer.token);
        assert.equal(sale.totalAmount, '999999999998990000000.00001');
        await ok(`/sales/records/${record.id}`, supplier.token, 'PATCH', {
          updatedAt: sale.updatedAt,
          status: 'CANCELLED',
          reason: 'Buyer and seller agreed to cancel delivery',
        });
        const cancelled = await ok(`/sales/records/${record.id}`, buyer.token);
        assert.equal(cancelled.status, 'CANCELLED');
        assert.ok(cancelled.cancelledAt);
        assert.equal(cancelled.completedAt, null);
        assert.equal(cancelled.quote.unitPrice, sale.quote.unitPrice);
        assert.equal(cancelled.totalAmount, sale.totalAmount);
        assert.equal((await detail(r.opp)).stage, 'WON');
      },
    );
    await t.test(
      'removed, flagged, declined and expired leads remain auditable with correct sales outcomes',
      async () => {
        const r = await submit();
        let d = await ok(`/admin/rfqs/${r.id}`, admin.token);
        await ok(`/admin/rfqs/${r.id}/flag`, admin.token, 'POST', {
          updatedAt: d.updatedAt,
          isFlagged: true,
          reason: 'Review',
        });
        let own = await detail(r.opp);
        assert.equal(own.canEdit, false);
        assert.equal(
          (
            await req(`/sales/opportunities/${r.opp}`, admin.token, 'PATCH', {
              updatedAt: own.updatedAt,
              internalNotes: 'blocked',
            })
          ).status,
          409,
        );
        d = await ok(`/admin/rfqs/${r.id}`, admin.token);
        await ok(`/admin/rfqs/${r.id}/flag`, admin.token, 'POST', {
          updatedAt: d.updatedAt,
          isFlagged: false,
          reason: 'Review cleared',
        });
        d = await ok(`/admin/rfqs/${r.id}`, admin.token);
        await ok(`/admin/rfqs/${r.id}/recipients`, admin.token, 'POST', {
          updatedAt: d.updatedAt,
          userIds: [supplier.id],
          action: 'REMOVE',
        });
        own = await detail(r.opp);
        assert.equal(own.stage, 'LOST');
        assert.equal(own.canEdit, false);
        assert.equal(
          (
            await req(
              `/sales/opportunities/${r.opp}`,
              supplier.token,
              'PATCH',
              { updatedAt: own.updatedAt, internalNotes: 'blocked' },
            )
          ).status,
          403,
        );
        const competitorLead = await prisma.rfqRecipient.findUniqueOrThrow({
          where: {
            rfqId_recipientId: { rfqId: r.id, recipientId: competitor.id },
          },
        });
        await ok(
          `/leads/${competitorLead.id}/decline`,
          competitor.token,
          'POST',
        );
        assert.equal((await detail(r.opp, admin.token)).stage, 'LOST');
        const expired = await submit();
        await prisma.rfq.update({
          where: { id: expired.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        await expireRfqs();
        assert.equal((await detail(expired.opp)).stage, 'LOST');
        const cancelled = await submit();
        d = await ok(`/rfqs/${cancelled.id}`, buyer.token);
        await ok(`/rfqs/${cancelled.id}/cancel`, buyer.token, 'POST', {
          updatedAt: d.updatedAt,
        });
        assert.equal((await detail(cancelled.opp)).stage, 'LOST');
      },
    );
    await t.test(
      'internal salespeople need no supplier subscription; global admin filters remain scoped',
      async () => {
        const r = await submit();
        const d = await ok(`/admin/rfqs/${r.id}`, admin.token);
        await ok(`/admin/rfqs/${r.id}/recipients`, admin.token, 'POST', {
          updatedAt: d.updatedAt,
          userIds: [salesperson.id],
          action: 'ADD',
        });
        const o = await prisma.salesOpportunity.findFirstOrThrow({
          where: { recipient: { rfqId: r.id, recipientId: salesperson.id } },
        });
        let own = await detail(o.id, salesperson.token);
        assert.equal(own.canEdit, true);
        await ok(`/sales/opportunities/${o.id}`, salesperson.token, 'PATCH', {
          updatedAt: own.updatedAt,
          stage: 'QUALIFIED',
        });
        own = await detail(o.id, salesperson.token);
        assert.equal(own.stage, 'QUALIFIED');
        const list = await ok(
          `/admin/sales/opportunities?q=${marker}&stage=WON&limit=1&sort=createdAt&direction=asc`,
          admin.token,
        );
        assert.equal(list.pagination.total, 2);
        assert.equal(list.opportunities.length, 1);
        assert.equal(
          (await req('/sales/opportunities?limit=100', supplier.token)).status,
          422,
        );
        assert.equal(
          (
            await req(
              '/sales/opportunities?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z',
              supplier.token,
            )
          ).status,
          422,
        );
      },
    );
  } finally {
    try {
      const scope = { opportunity: { recipient: { rfqId: { in: rfqs } } } };
      await prisma.salesEvent.deleteMany({ where: scope });
      await prisma.saleRecord.deleteMany({ where: scope });
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
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await disconnectDatabase();
    }
  }
});
