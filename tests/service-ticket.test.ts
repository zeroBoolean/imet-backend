import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import type { UserRole } from '../src/generated/client.js';
import {
  completedPurchase,
  cleanTicketFixtures,
} from './helpers/serviceTicketFixtures.js';

test('M10 completed-purchase service lifecycle, warranty, scoped history and subscription privacy', async (t) => {
  const prefix = `service-test-${randomUUID()}`,
    users: string[] = [];
  let categoryId: string | undefined, planId: string | undefined;
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/api/v1`;
  const req = async (
    path: string,
    token?: string,
    method = 'GET',
    input?: unknown,
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const account = async (role: UserRole, extra: UserRole[] = []) => {
    const u = await prisma.user.create({
      data: {
        email: `${prefix}-${users.length}@example.test`,
        displayName: role + ' fixture',
        password: 'fixture',
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: {
          create: [...new Set([role, ...extra])].map((role) => ({ role })),
        },
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
    return {
      id: u.id,
      token: signAccessToken(u.id, u.sessions[0].id),
      sessionId: u.sessions[0].id,
    };
  };
  try {
    const buyer = await account('BUYER'),
      other = await account('BUYER'),
      admin = await account('ADMIN'),
      owner = await account('LOCAL_SUPPLIER'),
      sales = await account('SALES_PERSON'),
      manufacturer = await account('INTERNATIONAL_MANUFACTURER'),
      independent = await account('INDEPENDENT_SELLER', ['LOCAL_SUPPLIER']);
    const category = await prisma.machineCategory.create({
      data: { name: prefix, slug: prefix },
    });
    categoryId = category.id;
    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: prefix,
        eligibleTypes: ['LOCAL', 'INTERNATIONAL'],
        durationDays: 30,
        price: 1,
        currency: 'USD',
        listingLimit: 10,
        imageLimit: 5,
        specificationLimit: 5,
        rfqEnabled: false,
        canPublishMachinery: true,
        visibility: 'STANDARD',
      },
    });
    planId = plan.id;
    const suppliers = [];
    for (const [user, type] of [
      [owner, 'LOCAL'],
      [manufacturer, 'INTERNATIONAL'],
      [independent, 'LOCAL'],
    ] as const) {
      const s = await prisma.supplier.create({
        data: {
          userId: user.id,
          companyName: prefix + type,
          description: 'Original supplier',
          type,
          contactName: 'PRIVATE SUPPLIER CONTACT',
          businessEmail: 'private@example.test',
          businessPhone: '+880123',
          address: 'PRIVATE ADDRESS',
          city: 'Dhaka',
          country: 'Bangladesh',
          documents: [],
          status: 'APPROVED',
          marketplaceVisible: true,
        },
      });
      suppliers.push(s);
      await prisma.supplierSubscription.create({
        data: {
          supplierId: s.id,
          planId: plan.id,
          planName: prefix,
          supplierType: type,
          durationDays: 30,
          price: 1,
          currency: 'USD',
          listingLimit: 10,
          imageLimit: 5,
          specificationLimit: 5,
          rfqEnabled: false,
          canPublishMachinery: true,
          visibility: 'STANDARD',
          state: 'ACTIVE',
          startsAt: new Date(Date.now() - 1000),
          endsAt: new Date(Date.now() + 86400000),
        },
      });
    }
    const machine = await prisma.machine.create({
      data: {
        name: 'Precision machinery',
        slug: prefix,
        categoryId: category.id,
        supplierId: suppliers[0].id,
        manufacturer: 'Original',
        model: 'CAT 320',
        description: 'Original source',
        status: 'DRAFT',
        images: {
          create: { url: 'https://example.test/original.jpg', alt: 'Original' },
        },
        specifications: { create: { label: 'Power', value: '5 kW' } },
      },
    });
    const purchase = await completedPurchase(
      buyer.id,
      owner.id,
      machine.id,
      category.id,
    );
    const input = {
      saleId: purchase.sale.id,
      customerRequestId: randomUUID(),
      subject: 'Hydraulic pressure issue',
      description: 'Machine pressure drops. Please inspect.',
      warrantyRequested: true,
    };
    let id = '';
    const detail = async (token = admin.token) => {
      const r = await req(`/service-tickets/${id}`, token);
      assert.equal(r.status, 200);
      return r.body.data;
    };
    const action = async (token: string, status: string, note?: string) => {
      const current = await detail(token);
      return req(`/service-tickets/${id}/status`, token, 'PATCH', {
        updatedAt: current.updatedAt,
        status,
        ...(note
          ? status === 'RESOLVED'
            ? { resolution: note }
            : { note }
          : {}),
      });
    };
    await t.test(
      'creation requires own completed purchase and live buyer account; retries deduplicate without rewriting source data',
      async () => {
        assert.equal(
          (await req('/service-tickets', undefined, 'POST', input)).status,
          401,
        );
        assert.equal(
          (await req('/service-tickets', owner.token, 'POST', input)).status,
          403,
        );
        assert.equal(
          (await req('/service-tickets', other.token, 'POST', input)).status,
          422,
        );
        await prisma.saleRecord.update({
          where: { id: purchase.sale.id },
          data: { status: 'RECORDED', completedAt: null },
        });
        assert.equal(
          (await req('/service-tickets', buyer.token, 'POST', input)).status,
          422,
        );
        await prisma.saleRecord.update({
          where: { id: purchase.sale.id },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        assert.equal(
          (
            await req('/service-tickets', buyer.token, 'POST', {
              ...input,
              customerId: other.id,
            })
          ).status,
          422,
        );
        const responses = await Promise.all([
          req('/service-tickets', buyer.token, 'POST', input),
          req('/service-tickets', buyer.token, 'POST', input),
        ]);
        assert.equal(responses[0].status, 201);
        assert.equal(responses[1].status, 201);
        id = responses[0].body.data.id;
        assert.equal(id, responses[1].body.data.id);
        assert.equal(
          await prisma.serviceTicket.count({
            where: { saleId: purchase.sale.id },
          }),
          1,
        );
        assert.equal(
          await prisma.serviceTicketEvent.count({ where: { ticketId: id } }),
          1,
        );
        assert.equal(
          (
            await req('/service-tickets', buyer.token, 'POST', {
              ...input,
              subject: 'Different issue',
            })
          ).status,
          409,
        );
        const eligible = await req(
          '/service-tickets/eligible-purchases',
          buyer.token,
        );
        assert.equal(eligible.body.data.purchases[0].machine.model, 'CAT 320');
        const own = await detail(buyer.token);
        assert.equal(own.status, 'OPEN');
        assert.equal(own.warrantyAssessment, 'PENDING');
        assert.equal(own.permissions.canReview, false);
        assert.equal(
          (await req(`/service-tickets/${id}`, other.token)).status,
          404,
        );
        assert.equal(
          (await req(`/service-tickets/${id}`, owner.token)).status,
          404,
        );
        assert.equal(
          (await req('/admin/service-tickets', buyer.token)).status,
          403,
        );
        await prisma.user.update({
          where: { id: buyer.id },
          data: { status: 'SUSPENDED' },
        });
        assert.equal(
          (await req(`/service-tickets/${id}`, buyer.token)).status,
          403,
        );
        await prisma.user.update({
          where: { id: buyer.id },
          data: { status: 'ACTIVE' },
        });
      },
    );
    await t.test(
      'admin reviews and assigns only original seller or salesperson; invalid jumps and forged assignment are rejected',
      async () => {
        assert.equal((await action(admin.token, 'CLOSED')).status, 409);
        assert.equal((await action(buyer.token, 'UNDER_REVIEW')).status, 403);
        assert.equal((await action(admin.token, 'UNDER_REVIEW')).status, 200);
        let current = await detail();
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/assignment`,
              buyer.token,
              'PATCH',
              { updatedAt: current.updatedAt, assignedToId: owner.id },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/assignment`,
              admin.token,
              'PATCH',
              { updatedAt: current.updatedAt, assignedToId: manufacturer.id },
            )
          ).status,
          422,
        );
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/assignment`,
              admin.token,
              'PATCH',
              { updatedAt: current.updatedAt, assignedToId: buyer.id },
            )
          ).status,
          422,
        );
        const candidates = await req(
          `/admin/service-tickets/${id}/assignees`,
          admin.token,
        );
        assert.deepEqual(
          new Set(
            candidates.body.data.candidates.map((c: { id: string }) => c.id),
          ),
          new Set([owner.id, sales.id]),
        );
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/assignment`,
              admin.token,
              'PATCH',
              { updatedAt: current.updatedAt, assignedToId: owner.id },
            )
          ).status,
          200,
        );
        current = await detail(owner.token);
        assert.equal(current.status, 'ASSIGNED');
        assert.equal(current.permissions.canStart, true);
        assert.equal((await action(owner.token, 'IN_PROGRESS')).status, 422);
        assert.equal(
          (
            await action(
              owner.token,
              'IN_PROGRESS',
              'Diagnosing hydraulic pressure.',
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      'customer progress excludes private service/sales/contact information; history is paginated and customer cannot add internal notes',
      async () => {
        let current = await detail(owner.token);
        assert.equal(
          (
            await req(`/service-tickets/${id}/notes`, owner.token, 'POST', {
              updatedAt: current.updatedAt,
              note: 'PRIVATE SERVICE DIAGNOSIS',
              visibility: 'INTERNAL',
            })
          ).status,
          200,
        );
        current = await detail(buyer.token);
        assert.equal(
          (
            await req(`/service-tickets/${id}/notes`, buyer.token, 'POST', {
              updatedAt: current.updatedAt,
              note: 'Hidden claim',
              visibility: 'INTERNAL',
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req(`/service-tickets/${id}/notes`, buyer.token, 'POST', {
              updatedAt: current.updatedAt,
              note: 'Pressure still drops after startup.',
              visibility: 'PUBLIC',
            })
          ).status,
          200,
        );
        const publicHistory = await req(
            `/service-tickets/${id}/events?page=1&limit=2`,
            buyer.token,
          ),
          staffHistory = await req(
            `/service-tickets/${id}/events`,
            owner.token,
          );
        assert.equal(publicHistory.body.data.events.length, 2);
        assert.equal(publicHistory.body.data.pagination.total, 5);
        assert.equal(staffHistory.body.data.pagination.total, 6);
        for (const path of [
          `/service-tickets/${id}`,
          `/service-tickets/${id}/events`,
          '/service-tickets',
        ]) {
          const r = await req(path, buyer.token);
          const json = JSON.stringify(r.body);
          for (const privateText of [
            'PRIVATE SERVICE',
            'PRIVATE QUOTE',
            'PRIVATE SALES',
            'PRIVATE ADDRESS',
            '98765.43',
            'private@example.test',
          ])
            assert.ok(!json.includes(privateText));
        }
        assert.equal(
          (await req(`/service-tickets/${id}/events`, other.token)).status,
          404,
        );
      },
    );
    await t.test(
      'subscription expiry retains assigned history but forbids staff changes; buyers/admin/salespeople keep applicable exemptions',
      async () => {
        await prisma.supplierSubscription.updateMany({
          where: { supplierId: suppliers[0].id },
          data: { endsAt: new Date(Date.now() - 1) },
        });
        const expired = await detail(owner.token);
        assert.equal(expired.permissions.canResolve, false);
        assert.match(expired.permissions.readOnlyReason, /subscription/);
        assert.equal(
          (await action(owner.token, 'RESOLVED', 'Pressure repaired.')).status,
          403,
        );
        assert.equal(
          (await req(`/service-tickets/${id}/events`, owner.token)).status,
          200,
        );
        assert.equal((await detail(buyer.token)).permissions.canComment, true);
        const v = await detail();
        const parallel = await Promise.all([
          req(`/admin/service-tickets/${id}/assignment`, admin.token, 'PATCH', {
            updatedAt: v.updatedAt,
            assignedToId: sales.id,
          }),
          req(`/admin/service-tickets/${id}/warranty`, admin.token, 'PATCH', {
            updatedAt: v.updatedAt,
            assessment: 'APPROVED',
            note: 'Manual documented acceptance.',
          }),
        ]);
        assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 409]);
        if ((await detail()).assignedTo?.id !== sales.id) {
          const now = await detail();
          assert.equal(
            (
              await req(
                `/admin/service-tickets/${id}/assignment`,
                admin.token,
                'PATCH',
                { updatedAt: now.updatedAt, assignedToId: sales.id },
              )
            ).status,
            200,
          );
        }
        assert.equal(
          (await req(`/service-tickets/${id}`, owner.token)).status,
          404,
        );
        assert.equal((await detail(sales.token)).permissions.canResolve, true);
      },
    );
    await t.test(
      'manual warranty assessment and resolution/closure are recorded atomically and closed tickets are read-only',
      async () => {
        await prisma.serviceTicket.update({
          where: { id },
          data: {
            warrantyAssessment: 'PENDING',
            warrantyNote: null,
            warrantyReviewedById: null,
            warrantyReviewedAt: null,
          },
        });
        let now = await detail();
        assert.equal((await action(sales.token, 'RESOLVED')).status, 422);
        assert.equal(
          (
            await action(
              sales.token,
              'RESOLVED',
              'Hydraulic pressure restored; tested under normal operating load.',
            )
          ).status,
          200,
        );
        assert.equal((await action(admin.token, 'CLOSED')).status, 409);
        assert.equal((await detail()).permissions.canClose, false);
        now = await detail();
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/warranty`,
              sales.token,
              'PATCH',
              {
                updatedAt: now.updatedAt,
                assessment: 'APPROVED',
                note: 'Unauthorized',
              },
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await req(
              `/admin/service-tickets/${id}/warranty`,
              admin.token,
              'PATCH',
              {
                updatedAt: now.updatedAt,
                assessment: 'APPROVED',
                note: 'Manual coverage decision recorded; no automatic policy calculation.',
              },
            )
          ).status,
          200,
        );
        assert.equal((await action(buyer.token, 'CLOSED')).status, 403);
        assert.equal((await action(admin.token, 'CLOSED')).status, 200);
        now = await detail(buyer.token);
        assert.equal(now.status, 'CLOSED');
        assert.ok(now.closedAt);
        assert.ok(now.resolvedAt);
        assert.equal(now.warrantyAssessment, 'APPROVED');
        assert.equal(now.permissions.canComment, false);
        assert.equal(
          (
            await req(`/service-tickets/${id}/notes`, buyer.token, 'POST', {
              updatedAt: now.updatedAt,
              note: 'After closure',
              visibility: 'PUBLIC',
            })
          ).status,
          409,
        );
        assert.equal(
          (await action(admin.token, 'IN_PROGRESS', 'Reopen')).status,
          409,
        );
        const originals = await prisma.machine.findUniqueOrThrow({
          where: { id: machine.id },
          include: { images: true, specifications: true },
        });
        assert.equal(originals.description, 'Original source');
        assert.equal(
          originals.images[0].url,
          'https://example.test/original.jpg',
        );
        assert.equal(originals.specifications[0].value, '5 kW');
      },
    );
    await t.test(
      'manufacturers and independent sellers operate only their own original-sale assignments; RFQ plan flag does not gate service',
      async () => {
        for (const actor of [manufacturer, independent]) {
          const p = await completedPurchase(
            buyer.id,
            actor.id,
            machine.id,
            category.id,
          );
          const created = await req('/service-tickets', buyer.token, 'POST', {
            ...input,
            saleId: p.sale.id,
            customerRequestId: randomUUID(),
            warrantyRequested: false,
          });
          assert.equal(created.status, 201);
          const newId = created.body.data.id;
          let version = (await req(`/service-tickets/${newId}`, admin.token))
            .body.data.updatedAt;
          assert.equal(
            (
              await req(
                `/service-tickets/${newId}/status`,
                admin.token,
                'PATCH',
                { updatedAt: version, status: 'UNDER_REVIEW' },
              )
            ).status,
            200,
          );
          version = (await req(`/service-tickets/${newId}`, admin.token)).body
            .data.updatedAt;
          assert.equal(
            (
              await req(
                `/admin/service-tickets/${newId}/assignment`,
                admin.token,
                'PATCH',
                { updatedAt: version, assignedToId: actor.id },
              )
            ).status,
            200,
          );
          const actorDetail = (
            await req(`/service-tickets/${newId}`, actor.token)
          ).body.data;
          assert.equal(actorDetail.permissions.canStart, true);
          assert.equal(
            (await req(`/service-tickets/${newId}`, sales.token)).status,
            404,
          );
          assert.equal(
            (
              await req(
                `/admin/service-tickets/${newId}/warranty`,
                admin.token,
                'PATCH',
                {
                  updatedAt: actorDetail.updatedAt,
                  assessment: 'APPROVED',
                  note: 'Not requested',
                },
              )
            ).status,
            409,
          );
        }
        const filtered = await req(
          '/service-tickets?view=assigned&status=ASSIGNED&limit=1',
          manufacturer.token,
        );
        assert.equal(filtered.body.data.tickets.length, 1);
        assert.equal(filtered.body.data.pagination.total, 1);
      },
    );
  } finally {
    await cleanTicketFixtures(users, categoryId);
    if (planId)
      await prisma.subscriptionPlan.deleteMany({ where: { id: planId } });
    await new Promise<void>((r) => server.close(() => r()));
    await disconnectDatabase();
  }
});
