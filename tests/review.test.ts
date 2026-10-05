import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import type { UserRole } from '../src/generated/client.js';

// Integration tests exercise the existing M5 HTTP flow, not synthetic sales stages.
test('M7 reviews, moderation, public ratings and live plans', async (t) => {
  const marker = `review-test-${randomUUID()}`;
  const extraPlans: string[] = [];
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
    const reviewedMachine = await prisma.machine.findFirstOrThrow({
      where: { supplier: { userId: supplier.id } },
    });
    const input = {
      machineId: reviewedMachine.id,
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
    let completed = { id: '', opp: '' },
      saleId = '',
      machineryReviewId = '',
      supplierReviewId = '';
    const latest = async (id: string) =>
      prisma.review.findUniqueOrThrow({ where: { id } });
    const publicReviews = (target: string, targetId: string) =>
      ok(`/reviews/public?target=${target}&targetId=${targetId}`, '');
    const winningSupplier = await prisma.supplier.findUniqueOrThrow({
      where: { userId: supplier.id },
    });
    const moderate = async (
      id: string,
      status: 'PUBLISHED' | 'REJECTED' | 'HIDDEN',
    ) => {
      const r = await latest(id);
      return ok(`/admin/reviews/${id}`, admin.token, 'PATCH', {
        updatedAt: r.updatedAt.toISOString(),
        status,
        note: 'Reviewed by administrator',
      });
    };
    await t.test(
      'only completed-sale buyers are eligible; target and author IDs cannot be forged',
      async () => {
        completed = await submit();
        const q = await ok(
          `/rfqs/${completed.id}/quotes`,
          supplier.token,
          'POST',
          quoteInput,
          201,
        );
        await ok(`/quotes/${q.id}/accept`, buyer.token, 'POST', {
          updatedAt: q.updatedAt,
        });
        const o = await detail(completed.opp);
        const sale = await ok(
          `/sales/opportunities/${completed.opp}/record-sale`,
          supplier.token,
          'POST',
          { updatedAt: o.updatedAt },
          201,
        );
        saleId = sale.id;
        assert.equal((await req('/reviews', salesperson.token)).status, 403);
        const body = {
          saleId,
          target: 'MACHINERY',
          rating: 5,
          body: 'Excellent cutting accuracy',
        };
        assert.equal(
          (await req('/reviews', undefined, 'POST', body)).status,
          401,
        );
        assert.equal(
          (await req('/reviews', supplier.token, 'POST', body)).status,
          403,
        );
        assert.equal(
          (await req('/reviews', stranger.token, 'POST', body)).status,
          404,
        );
        assert.equal(
          (await req('/reviews', buyer.token, 'POST', body)).status,
          403,
        );
        assert.equal(
          (await ok(`/reviews/eligibility/${saleId}`, buyer.token)).eligible,
          false,
        );
        await ok(`/sales/records/${saleId}`, supplier.token, 'PATCH', {
          updatedAt: sale.updatedAt,
          status: 'COMPLETED',
        });
        const eligibility = await ok(
          `/reviews/eligibility/${saleId}`,
          buyer.token,
        );
        assert.equal(eligibility.eligible, true);
        assert.equal(eligibility.targets.length, 2);
        assert.equal(
          (
            await req('/reviews', buyer.token, 'POST', {
              ...body,
              authorId: stranger.id,
              machineId: reviewedMachine.id,
            })
          ).status,
          422,
        );
        for (const rating of [0, 6, 1.5])
          assert.equal(
            (await req('/reviews', buyer.token, 'POST', { ...body, rating }))
              .status,
            422,
          );
        assert.equal(
          (await req('/reviews', buyer.token, 'POST', { ...body, body: '   ' }))
            .status,
          422,
        );
        assert.equal(
          (
            await req('/reviews', buyer.token, 'POST', {
              ...body,
              body: 'x'.repeat(5001),
            })
          ).status,
          422,
        );
        assert.equal(
          (await req('/reviews/eligibility/not-a-uuid', buyer.token)).status,
          422,
        );
      },
    );
    await t.test(
      'creation races yield one pending review; public summaries never include pending private records',
      async () => {
        const body = {
          saleId,
          target: 'MACHINERY',
          rating: 5,
          body: 'Excellent cutting accuracy',
        };
        const attempts = await Promise.all([
          req('/reviews', buyer.token, 'POST', body),
          req('/reviews', buyer.token, 'POST', body),
        ]);
        assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
        machineryReviewId = attempts.find((r) => r.status === 201)!.body.data
          .id;
        const sr = await ok(
          '/reviews',
          buyer.token,
          'POST',
          {
            saleId,
            target: 'SUPPLIER',
            rating: 4,
            body: 'Reliable supplier documentation',
          },
          201,
        );
        supplierReviewId = sr.id;
        assert.equal(sr.supplierId, winningSupplier.id);
        const pub = await publicReviews('MACHINERY', reviewedMachine.id);
        assert.equal(pub.summary.count, 0);
        assert.equal(pub.summary.average, null);
        assert.deepEqual(pub.reviews, []);
        assert.equal(
          (await ok('/reviews', stranger.token)).pagination.total,
          0,
        );
        assert.equal((await req('/admin/reviews', buyer.token)).status, 403);
        await prisma.user.update({
          where: { id: buyer.id },
          data: { status: 'SUSPENDED' },
        });
        assert.equal((await req('/reviews', buyer.token)).status, 403);
        await prisma.user.update({
          where: { id: buyer.id },
          data: { status: 'ACTIVE' },
        });
      },
    );
    await t.test(
      'admin publication exposes safe data, exact database counts and rating distribution',
      async () => {
        await moderate(machineryReviewId, 'PUBLISHED');
        await moderate(supplierReviewId, 'PUBLISHED');
        const pub = await publicReviews('MACHINERY', reviewedMachine.id);
        assert.equal(pub.summary.average, 5);
        assert.equal(pub.summary.count, 1);
        assert.equal(pub.summary.distribution['5'], 1);
        for (const key of [
          'saleId',
          'authorId',
          'moderationNote',
          'moderatedById',
          'targetBudget',
          'businessEmail',
          'unitPrice',
          'SECRET CONTACT',
        ])
          assert.ok(!JSON.stringify(pub).includes(key));
        assert.equal(
          (await publicReviews('SUPPLIER', winningSupplier.id)).summary.average,
          4,
        );
        const second = await submit();
        const quote = await ok(
          `/rfqs/${second.id}/quotes`,
          supplier.token,
          'POST',
          quoteInput,
          201,
        );
        await ok(`/quotes/${quote.id}/accept`, buyer.token, 'POST', {
          updatedAt: quote.updatedAt,
        });
        const opportunity = await detail(second.opp);
        const record = await ok(
          `/sales/opportunities/${second.opp}/record-sale`,
          supplier.token,
          'POST',
          { updatedAt: opportunity.updatedAt },
          201,
        );
        await ok(`/sales/records/${record.id}`, supplier.token, 'PATCH', {
          updatedAt: record.updatedAt,
          status: 'COMPLETED',
        });
        const secondReview = await ok(
          '/reviews',
          buyer.token,
          'POST',
          {
            saleId: record.id,
            target: 'MACHINERY',
            rating: 1,
            body: 'A different completed-purchase experience',
          },
          201,
        );
        await moderate(secondReview.id, 'PUBLISHED');
        const combined = await publicReviews('MACHINERY', reviewedMachine.id);
        assert.equal(combined.summary.average, 3);
        assert.equal(combined.summary.count, 2);
        assert.equal(combined.summary.distribution['1'], 1);
        assert.equal(combined.summary.distribution['5'], 1);
        const page = await ok(
          `/reviews/public?target=MACHINERY&targetId=${reviewedMachine.id}&limit=1`,
          '',
        );
        assert.equal(page.reviews.length, 1);
        assert.equal(page.pagination.totalPages, 2);
        const secondVersion = await latest(secondReview.id);
        await ok(`/reviews/${secondReview.id}/withdraw`, buyer.token, 'POST', {
          updatedAt: secondVersion.updatedAt.toISOString(),
        });
        const highlights = await ok('/reviews/highlights?limit=6', '');
        assert.ok(
          highlights.some((r: { id: string }) => r.id === machineryReviewId),
        );
        assert.ok(!JSON.stringify(highlights).includes('saleId'));
        assert.equal(
          (await req('/reviews/public?target=MACHINERY&targetId=invalid'))
            .status,
          422,
        );
        assert.equal(
          (
            await req(
              `/reviews/public?target=MACHINERY&targetId=${randomUUID()}`,
            )
          ).status,
          404,
        );
        assert.equal((await req('/reviews/highlights?limit=50')).status, 422);
      },
    );
    await t.test(
      'buyer edits remove publication; withdrawals cannot be overridden and edits resubmit same record',
      async () => {
        const old = await latest(machineryReviewId);
        assert.equal(
          (
            await req(`/reviews/${old.id}`, stranger.token, 'PATCH', {
              updatedAt: old.updatedAt.toISOString(),
              rating: 3,
              body: 'Forged',
            })
          ).status,
          404,
        );
        await ok(`/reviews/${old.id}`, buyer.token, 'PATCH', {
          updatedAt: old.updatedAt.toISOString(),
          rating: 3,
          body: 'Updated completed-purchase feedback',
        });
        assert.equal(
          (await publicReviews('MACHINERY', reviewedMachine.id)).summary.count,
          0,
        );
        assert.equal(
          (
            await req(`/admin/reviews/${old.id}`, admin.token, 'PATCH', {
              updatedAt: old.updatedAt.toISOString(),
              status: 'PUBLISHED',
              note: '',
            })
          ).status,
          409,
        );
        await moderate(old.id, 'PUBLISHED');
        const version = (await latest(old.id)).updatedAt.toISOString();
        const races = await Promise.all([
          req(`/reviews/${old.id}/withdraw`, buyer.token, 'POST', {
            updatedAt: version,
          }),
          req(`/admin/reviews/${old.id}`, admin.token, 'PATCH', {
            updatedAt: version,
            status: 'HIDDEN',
            note: 'Review',
          }),
        ]);
        assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
        let r = await latest(old.id);
        if (r.status !== 'WITHDRAWN')
          await ok(`/reviews/${old.id}/withdraw`, buyer.token, 'POST', {
            updatedAt: r.updatedAt.toISOString(),
          });
        r = await latest(old.id);
        assert.equal(
          (
            await req(`/admin/reviews/${old.id}`, admin.token, 'PATCH', {
              updatedAt: r.updatedAt.toISOString(),
              status: 'PUBLISHED',
              note: '',
            })
          ).status,
          409,
        );
        await ok(`/reviews/${old.id}`, buyer.token, 'PATCH', {
          updatedAt: r.updatedAt.toISOString(),
          rating: 3,
          body: 'Resubmitted feedback',
        });
        assert.equal(
          await prisma.review.count({ where: { saleId, target: 'MACHINERY' } }),
          1,
        );
        await moderate(old.id, 'REJECTED');
        assert.equal(
          (await publicReviews('MACHINERY', reviewedMachine.id)).summary.count,
          0,
        );
        r = await latest(old.id);
        await ok(`/reviews/${old.id}`, buyer.token, 'PATCH', {
          updatedAt: r.updatedAt.toISOString(),
          rating: 3,
          body: 'Revised feedback',
        });
        await moderate(old.id, 'PUBLISHED');
        assert.equal(
          (await publicReviews('MACHINERY', reviewedMachine.id)).summary
            .average,
          3,
        );
        await moderate(old.id, 'HIDDEN');
        assert.equal(
          (await publicReviews('MACHINERY', reviewedMachine.id)).summary.count,
          0,
        );
      },
    );
    await t.test(
      'buyers keep feedback access after supplier expiry; public target visibility and highlights obey M4',
      async () => {
        await prisma.supplierSubscription.update({
          where: { id: terms[0] },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        const r = await latest(supplierReviewId);
        await ok(`/reviews/${r.id}`, buyer.token, 'PATCH', {
          updatedAt: r.updatedAt.toISOString(),
          rating: 2,
          body: 'Historical feedback after expiry',
        });
        assert.equal(
          (
            await req(
              `/reviews/public?target=SUPPLIER&targetId=${winningSupplier.id}`,
            )
          ).status,
          404,
        );
        assert.equal(
          (
            await req(
              `/reviews/public?target=MACHINERY&targetId=${reviewedMachine.id}`,
            )
          ).status,
          404,
        );
        const highlights = await ok('/reviews/highlights?limit=6', '');
        assert.ok(
          !highlights.some((r: { id: string }) => r.id === supplierReviewId),
        );
        await prisma.supplierSubscription.update({
          where: { id: terms[0] },
          data: { endsAt: new Date(Date.now() + 86400000) },
        });
        await moderate(supplierReviewId, 'PUBLISHED');
      },
    );
    await t.test(
      'public plans reflect admin creation, price/limits updates and deactivation without exposing private terms',
      async () => {
        let p = await prisma.subscriptionPlan.findUniqueOrThrow({
          where: { id: plan.id },
        });
        const publicPlans = await ok('/subscriptions/plans', '');
        const projection = publicPlans.find(
          (x: { id: string }) => x.id === p.id,
        );
        assert.ok(projection);
        assert.equal(projection.price, '10');
        assert.ok(!('subscriptions' in projection));
        assert.ok(!('updatedAt' in projection));
        const data = {
          name: p.name,
          eligibleTypes: p.eligibleTypes,
          durationDays: p.durationDays,
          price: '12',
          currency: p.currency,
          listingLimit: 7,
          imageLimit: p.imageLimit,
          specificationLimit: p.specificationLimit,
          canPublishMachinery: p.canPublishMachinery,
          visibility: p.visibility,
          isActive: true,
          rfqEnabled: true,
          leadLimitPerMonth: 3,
          canRevealContacts: false,
        };
        const createdPlan = await ok(
          '/admin/subscriptions/plans',
          admin.token,
          'POST',
          { ...data, name: `${marker}-created` },
          201,
        );
        extraPlans.push(createdPlan.id);
        assert.ok(
          (await ok('/subscriptions/plans', '')).some(
            (x: { id: string }) => x.id === createdPlan.id,
          ),
        );
        await ok(`/admin/subscriptions/plans/${p.id}`, admin.token, 'PUT', {
          ...data,
          updatedAt: p.updatedAt.toISOString(),
        });
        const changed = (await ok('/subscriptions/plans', '')).find(
          (x: { id: string }) => x.id === p.id,
        );
        assert.equal(changed.price, '12');
        assert.equal(changed.listingLimit, 7);
        assert.equal(changed.leadLimitPerMonth, 3);
        p = await prisma.subscriptionPlan.findUniqueOrThrow({
          where: { id: p.id },
        });
        await ok(`/admin/subscriptions/plans/${p.id}`, admin.token, 'PUT', {
          ...data,
          isActive: false,
          updatedAt: p.updatedAt.toISOString(),
        });
        assert.ok(
          !(await ok('/subscriptions/plans', '')).some(
            (x: { id: string }) => x.id === p.id,
          ),
        );
        // Existing subscription snapshots are unaffected by editing the plan source.
        assert.equal(
          (
            await prisma.supplierSubscription.findUniqueOrThrow({
              where: { id: terms[0] },
            })
          ).price.toString(),
          '10',
        );
      },
    );
  } finally {
    try {
      await prisma.review.deleteMany({ where: { authorId: { in: users } } });
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
      await prisma.subscriptionPlan.deleteMany({
        where: { id: { in: extraPlans } },
      });
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
