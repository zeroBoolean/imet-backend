import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import {
  dateRange,
  overviewSchema,
} from '../src/modules/analytics/analytics.validation.js';
import { auditQuery } from '../src/modules/audit/audit.validation.js';
import { safeContext } from '../src/modules/audit/audit.service.js';
import { catalogueAdminService as catalogue } from '../src/modules/catalogue/catalogue.admin.service.js';
import { supplierService } from '../src/modules/supplier/supplier.service.js';
import { subscriptionService } from '../src/modules/subscription/subscription.service.js';
import { userService } from '../src/modules/user/user.service.js';
import { reviewService } from '../src/modules/review/review.service.js';
import {
  completedPurchase,
  cleanTicketFixtures,
} from './helpers/serviceTicketFixtures.js';

test('M12 validates calendar ranges, pagination and defensive safe projections', () => {
  const range = dateRange({}, new Date('2026-10-04T18:00:00Z'));
  assert.equal(range.to, '2026-10-05');
  assert.equal(range.from, '2026-09-06');
  assert.equal(range.start.toISOString(), '2026-09-05T18:00:00.000Z');
  assert.equal(range.end.toISOString(), '2026-10-05T18:00:00.000Z');
  const historical = dateRange({ from: '2009-07-01', to: '2009-07-01' });
  assert.equal(historical.start.toISOString(), '2009-06-30T17:00:00.000Z');
  assert.equal(historical.end.toISOString(), '2009-07-01T17:00:00.000Z');
  const transition = dateRange({ from: '2009-12-31', to: '2009-12-31' });
  assert.equal(
    transition.end.getTime() - transition.start.getTime(),
    25 * 3600000,
  );
  for (const query of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-01-01' },
    { from: '2026-01-02', to: '2026-01-01' },
    { from: '2026-01-01', to: '2026-04-01' },
    { extra: 'ignored' },
  ])
    assert.equal(overviewSchema.safeParse({ query }).success, false);
  assert.equal(
    overviewSchema.safeParse({
      query: { from: '2026-01-01', to: '2026-03-31' },
    }).success,
    true,
  );
  assert.equal(auditQuery.safeParse({ limit: 51 }).success, false);
  assert.equal(auditQuery.safeParse({ actorId: 'invalid' }).success, false);
  assert.deepEqual(
    safeContext({
      changedFields: ['status', 'password', 'token', '<script>'],
      before: {
        status: 'ACTIVE',
        email: 'private',
        roles: ['ADMIN', 'private'],
        notes: 'PRIVATE',
      },
      after: { state: 'SUSPENDED', price: '98765.43' },
      secret: 'PRIVATE',
    }),
    {
      changedFields: ['status'],
      before: { status: 'ACTIVE', roles: ['ADMIN'] },
      after: { state: 'SUSPENDED' },
    },
  );
});

test('M12 admin analytics, merged private-safe history and atomic governance mutations', async (t) => {
  const key = 'm12-' + randomUUID(),
    users: string[] = [],
    planIds: string[] = [];
  let categoryId: string | undefined;
  const listener = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = async (
    path: string,
    token?: string,
    method = 'GET',
    body?: unknown,
  ) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const account = async (roles: ('ADMIN' | 'BUYER' | 'SALES_PERSON')[]) => {
    const u = await prisma.user.create({
      data: {
        email: `${key}-${users.length}@example.test`,
        displayName: 'M12 fixture',
        password: 'unusable hash',
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
    return { ...u, token: signAccessToken(u.id, u.sessions[0].id) };
  };
  try {
    const admin = await account(['ADMIN', 'BUYER']),
      buyer = await account(['BUYER']),
      seller = await account(['BUYER']);
    await t.test(
      'both endpoints enforce live admin access, strict filters and read-only routes',
      async () => {
        for (const path of ['/admin/analytics/overview', '/admin/audit-logs']) {
          assert.equal((await request(path)).status, 401);
          assert.equal((await request(path, buyer.token)).status, 403);
          assert.equal(
            (
              await request(
                path + '?from=2026-02-30&to=2026-03-01',
                admin.token,
              )
            ).status,
            422,
          );
          assert.equal(
            (await request(path, admin.token, 'POST', {})).status,
            404,
          );
        }
        assert.equal(
          (await request('/admin/audit-logs?limit=51', admin.token)).status,
          422,
        );
        assert.equal(
          (
            await request(
              '/admin/analytics/overview?from=2026-01-01',
              admin.token,
            )
          ).status,
          422,
        );
      },
    );
    const category = await catalogue.createCategory(
      { name: key, slug: key },
      admin.id,
    );
    categoryId = category.id;
    const machineData = {
      name: key,
      slug: key,
      description: 'PRIVATE DESCRIPTION',
      manufacturer: 'Factory',
      model: 'M12',
      categoryId,
      status: 'PUBLISHED' as const,
      images: [],
      specifications: [],
    };
    let machine = await catalogue.create(machineData, undefined, admin.id);
    const profile = {
      companyName: key,
      type: 'LOCAL' as const,
      description: 'PRIVATE DESCRIPTION',
      contactName: 'PRIVATE CONTACT',
      businessEmail: `${key}@example.test`,
      businessPhone: 'PRIVATE PHONE',
      address: 'PRIVATE ADDRESS',
      city: 'Dhaka',
      country: 'Bangladesh',
      registrationNumber: null,
      website: null,
      logoUrl: null,
      documents: [],
    };
    const application = await supplierService.apply(seller.id, profile);
    let supplier = await supplierService.review(
      application.id,
      {
        status: 'APPROVED',
        isVerified: true,
        marketplaceVisible: true,
        reviewNote: 'PRIVATE REVIEW NOTE',
        updatedAt: application.updatedAt.toISOString(),
      },
      admin.id,
    );
    const planInput = {
      name: key,
      eligibleTypes: ['LOCAL' as const],
      durationDays: 30,
      price: '98765.43',
      currency: 'BDT',
      listingLimit: 5,
      imageLimit: 2,
      specificationLimit: 2,
      canPublishMachinery: true,
      visibility: 'STANDARD' as const,
      isActive: true,
      rfqEnabled: true,
    };
    let plan = await subscriptionService.createPlan(planInput, admin.id);
    planIds.push(plan.id);
    let term = await subscriptionService.assign(
      supplier.id,
      {
        planId: plan.id,
        expectedCurrentId: null,
        expectedCurrentUpdatedAt: null,
        startsAt: new Date(Date.now() - 86400000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        state: 'ACTIVE',
      },
      admin.id,
    );
    const purchase = await completedPurchase(
      buyer.id,
      seller.id,
      machine.id,
      categoryId,
    );
    const review = await prisma.review.create({
      data: {
        saleId: purchase.sale.id,
        authorId: buyer.id,
        target: 'MACHINERY',
        machineId: machine.id,
        rating: 5,
        body: 'PRIVATE REVIEW BODY',
      },
    });
    await reviewService.moderate(
      { id: admin.id, roles: ['ADMIN'] },
      review.id,
      {
        status: 'PUBLISHED',
        note: 'PRIVATE MODERATION NOTE',
        updatedAt: review.updatedAt.toISOString(),
      },
    );
    const ticket = await prisma.serviceTicket.create({
      data: {
        customerId: buyer.id,
        machineId: machine.id,
        saleId: purchase.sale.id,
        customerRequestId: randomUUID(),
        subject: 'PRIVATE SUBJECT',
        description: 'PRIVATE SERVICE BODY',
      },
    });
    const rfqEvent = await prisma.rfqEvent.create({
      data: {
        rfqId: purchase.rfq.id,
        actorId: null,
        eventType: 'SUBMITTED',
        metadata: { notes: 'PRIVATE RFQ NOTES', price: '98765.43' },
      },
    });
    const salesEvent = await prisma.salesEvent.create({
      data: {
        opportunityId: purchase.opportunity.id,
        actorId: seller.id,
        eventType: 'SALE_COMPLETED',
        metadata: { notes: 'PRIVATE SALES NOTES' },
      },
    });
    const serviceEvent = await prisma.serviceTicketEvent.create({
      data: {
        ticketId: ticket.id,
        actorId: admin.id,
        type: 'STATUS_CHANGED',
        fromStatus: 'OPEN',
        toStatus: 'IN_PROGRESS',
        note: 'PRIVATE INTERNAL NOTE',
        visibility: 'INTERNAL',
      },
    });
    await t.test(
      'all approved governance actions record safe actor/resource/context once',
      async () => {
        await catalogue.updateCategory(
          category.id,
          { name: key + ' updated', slug: key },
          admin.id,
        );
        machine = await catalogue.update(
          machine.id,
          {
            ...machineData,
            name: key + ' updated',
            updatedAt: machine.updatedAt.toISOString(),
          },
          undefined,
          admin.id,
        );
        supplier = await supplierService.adminUpdate(
          supplier.id,
          { ...profile, updatedAt: supplier.updatedAt.toISOString() },
          admin.id,
        );
        plan = await subscriptionService.updatePlan(
          plan.id,
          {
            ...planInput,
            isActive: false,
            updatedAt: plan.updatedAt.toISOString(),
          },
          admin.id,
        );
        term = await subscriptionService.update(
          term.id,
          {
            startsAt: term.startsAt.toISOString(),
            endsAt: term.endsAt.toISOString(),
            state: 'SUSPENDED',
            updatedAt: term.updatedAt.toISOString(),
          },
          admin.id,
        );
        await userService.update(admin.id, buyer.id, {
          roles: ['BUYER', 'SALES_PERSON'],
        });
        const disposable = await catalogue.create(
          { ...machineData, slug: key + '-disposable' },
          undefined,
          admin.id,
        );
        await catalogue.remove(
          disposable.id,
          disposable.updatedAt.toISOString(),
          undefined,
          admin.id,
        );
        const removable = await catalogue.createCategory(
          { name: key, slug: key + '-disposable' },
          admin.id,
        );
        await catalogue.deleteCategory(removable.id, admin.id);
        const rows = await prisma.auditLog.findMany({
          where: { actorId: admin.id },
        });
        for (const action of [
          'USER_ACCESS_UPDATED',
          'CATEGORY_CREATED',
          'CATEGORY_UPDATED',
          'CATEGORY_DELETED',
          'MACHINERY_CREATED',
          'MACHINERY_UPDATED',
          'MACHINERY_DELETED',
          'SUPPLIER_ADMIN_UPDATED',
          'SUBSCRIPTION_PLAN_CREATED',
          'SUBSCRIPTION_PLAN_UPDATED',
          'SUBSCRIPTION_ASSIGNED',
          'SUBSCRIPTION_UPDATED',
          'REVIEW_MODERATED',
        ])
          assert.ok(
            rows.some((r) => r.action === action),
            action,
          );
        assert.ok(rows.every((r) => r.actorId === admin.id));
        const serialized = JSON.stringify(rows);
        assert.ok(!serialized.includes('PRIVATE'));
        assert.ok(!serialized.includes('98765.43'));
        assert.ok(!serialized.includes('@example.test'));
        assert.equal(
          rows.filter(
            (r) =>
              r.action === 'REVIEW_MODERATED' && r.resourceId === review.id,
          ).length,
          1,
        );
      },
    );
    await t.test(
      'failed writes, stale mutations and missing actors leave no audit success; audit database failure rolls back change',
      async () => {
        const count = await prisma.auditLog.count({
          where: { actorId: admin.id },
        });
        await assert.rejects(
          catalogue.update(
            machine.id,
            { ...machineData, updatedAt: '2000-01-01T00:00:00Z' },
            undefined,
            admin.id,
          ),
        );
        await assert.rejects(
          catalogue.createCategory({ name: key, slug: key + '-no-actor' }),
        );
        assert.equal(
          await prisma.machineCategory.count({
            where: { slug: key + '-no-actor' },
          }),
          0,
        );
        const constraint = 'm12_test_' + randomUUID().replaceAll('-', '');
        // Scoped test-only constraint rejects this fixture actor's audit INSERT, never other users.
        await prisma.$executeRawUnsafe(
          `ALTER TABLE audit_logs ADD CONSTRAINT "${constraint}" CHECK ("actorId" <> '${admin.id}') NOT VALID`,
        );
        try {
          const r = await request(
            '/admin/catalogue/categories',
            admin.token,
            'POST',
            { name: key, slug: key + '-rollback' },
          );
          assert.equal(r.status, 500);
          assert.equal(
            await prisma.machineCategory.count({
              where: { slug: key + '-rollback' },
            }),
            0,
          );
        } finally {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE audit_logs DROP CONSTRAINT "${constraint}"`,
          );
        }
        assert.equal(
          await prisma.auditLog.count({ where: { actorId: admin.id } }),
          count,
        );
      },
    );
    await t.test(
      'existing histories merge once with stable tie pagination and no private domain payloads',
      async () => {
        const ids = [rfqEvent.id, salesEvent.id, serviceEvent.id];
        const instant = new Date('2026-10-04T18:00:00Z');
        await prisma.rfqEvent.update({
          where: { id: ids[0] },
          data: { createdAt: instant },
        });
        await prisma.salesEvent.update({
          where: { id: ids[1] },
          data: { createdAt: instant },
        });
        await prisma.serviceTicketEvent.update({
          where: { id: ids[2] },
          data: { createdAt: instant },
        });
        const all = await request(
          '/admin/audit-logs?from=2026-10-05&to=2026-10-05&limit=50',
          admin.token,
        );
        assert.equal(all.status, 200);
        const serialized = JSON.stringify(all.body);
        for (const secret of [
          'PRIVATE',
          '98765.43',
          '@example.test',
          'metadata',
          '"note"',
        ])
          assert.ok(!serialized.includes(secret), secret);
        for (const id of ids)
          assert.equal(
            all.body.data.entries.filter((r: { id: string }) =>
              r.id.endsWith(id),
            ).length,
            1,
          );
        const nullActor = all.body.data.entries.find((r: { id: string }) =>
          r.id.endsWith(rfqEvent.id),
        );
        assert.equal(nullActor.actor.id, null);
        assert.equal(nullActor.actor.displayName, null);
        const first = await request(
            '/admin/audit-logs?from=2026-10-05&to=2026-10-05&limit=1',
            admin.token,
          ),
          second = await request(
            '/admin/audit-logs?from=2026-10-05&to=2026-10-05&limit=1&page=2',
            admin.token,
          );
        assert.notEqual(
          first.body.data.entries[0].id,
          second.body.data.entries[0].id,
        );
        const filtered = await request(
          `/admin/audit-logs?source=SERVICE&resourceId=${ticket.id}&actorId=${admin.id}&action=STATUS_CHANGED`,
          admin.token,
        );
        assert.equal(filtered.body.data.pagination.total, 1);
        assert.equal(
          (
            await request(
              '/admin/audit-logs?from=2000-01-01&to=2000-01-01',
              admin.token,
            )
          ).body.data.pagination.total,
          0,
        );
      },
    );
    await t.test(
      'current metrics match database and day activity uses half-open Dhaka boundaries',
      async () => {
        await prisma.user.update({
          where: { id: seller.id },
          data: { createdAt: new Date('2000-01-01T18:00:00Z') },
        });
        await prisma.machine.update({
          where: { id: machine.id },
          data: { createdAt: new Date('2000-01-02T18:00:00Z') },
        });
        const r = await request(
          '/admin/analytics/overview?from=2000-01-02&to=2000-01-02',
          admin.token,
        );
        assert.equal(r.status, 200);
        const data = r.body.data;
        assert.equal(data.current.users.total, await prisma.user.count());
        assert.equal(
          data.current.userRoles.total,
          await prisma.userRoleAssignment.count(),
        );
        assert.equal(
          data.current.subscriptions.total,
          await prisma.supplierSubscription.count({
            where: { isCurrent: true },
          }),
        );
        assert.ok(data.current.subscriptions.counts.SUSPENDED >= 1);
        assert.equal(data.activity.days.length, 1);
        assert.equal(data.activity.days[0].counts.users, 1);
        assert.equal(data.activity.days[0].counts.machinery, 0);
        const empty = await request(
          '/admin/analytics/overview?from=1999-01-01&to=1999-01-02',
          admin.token,
        );
        assert.equal(empty.body.data.activity.days.length, 2);
        assert.ok(
          empty.body.data.activity.days.every(
            (d: { counts: Record<string, number> }) =>
              Object.values(d.counts).every((v) => v === 0),
          ),
        );
        const defaultResult = await request(
          '/admin/analytics/overview',
          admin.token,
        );
        assert.equal(defaultResult.body.data.activity.days.length, 30);
        assert.deepEqual(empty.body.data.current, data.current);
      },
    );
    await t.test(
      'effective current subscription states and bounded larger audit pages',
      async () => {
        const original = await prisma.supplierSubscription.findUniqueOrThrow({
          where: { id: term.id },
        });
        const baseline = (
          await request('/admin/analytics/overview', admin.token)
        ).body.data.current.subscriptions.counts;
        const past = new Date(Date.now() - 86400000),
          future = new Date(Date.now() + 86400000);
        for (const item of [
          {
            state: 'CANCELLED' as const,
            startsAt: past,
            endsAt: past,
            expected: 'CANCELLED',
          },
          {
            state: 'SUSPENDED' as const,
            startsAt: past,
            endsAt: past,
            expected: 'SUSPENDED',
          },
          {
            state: 'PENDING' as const,
            startsAt: past,
            endsAt: past,
            expected: 'EXPIRED',
          },
          {
            state: 'PENDING' as const,
            startsAt: past,
            endsAt: future,
            expected: 'PENDING',
          },
          {
            state: 'ACTIVE' as const,
            startsAt: future,
            endsAt: new Date(future.getTime() + 86400000),
            expected: 'PENDING',
          },
          {
            state: 'ACTIVE' as const,
            startsAt: past,
            endsAt: future,
            expected: 'ACTIVE',
          },
        ]) {
          // Existing DB constraints require a positive interval, including expired terms.
          await prisma.supplierSubscription.update({
            where: { id: term.id },
            data: {
              state: item.state,
              startsAt: item.startsAt,
              endsAt:
                item.endsAt.getTime() === item.startsAt.getTime()
                  ? new Date(item.endsAt.getTime() + 1000)
                  : item.endsAt,
            },
          });
          const current = (
            await request('/admin/analytics/overview', admin.token)
          ).body.data.current.subscriptions.counts;
          assert.equal(
            current[item.expected],
            (baseline[item.expected] ?? 0) -
              (item.expected === 'SUSPENDED' ? 1 : 0) +
              1,
          );
        }
        await prisma.supplierSubscription.update({
          where: { id: term.id },
          data: {
            state: original.state,
            startsAt: original.startsAt,
            endsAt: original.endsAt,
          },
        });
        await prisma.auditLog.createMany({
          data: Array.from({ length: 125 }, () => ({
            actorId: admin.id,
            action: 'CATEGORY_UPDATED',
            resourceType: 'CATEGORY' as const,
            resourceId: categoryId!,
            context: { changedFields: ['name'], before: {}, after: {} },
          })),
        });
        const page = await request(
          `/admin/audit-logs?actorId=${admin.id}&limit=50`,
          admin.token,
        );
        assert.equal(page.body.data.entries.length, 50);
        assert.ok(page.body.data.pagination.total >= 125);
        assert.equal(
          new Set(page.body.data.entries.map((e: { id: string }) => e.id)).size,
          50,
        );
      },
    );
    await t.test(
      'revoked sessions and removed admin role cannot read operations',
      async () => {
        await prisma.userSession.update({
          where: { id: admin.sessions[0].id },
          data: { revokedAt: new Date() },
        });
        assert.equal(
          (await request('/admin/analytics/overview', admin.token)).status,
          401,
        );
        await prisma.userSession.update({
          where: { id: admin.sessions[0].id },
          data: { revokedAt: null },
        });
        await prisma.userRoleAssignment.deleteMany({
          where: { userId: admin.id, role: 'ADMIN' },
        });
        assert.equal(
          (await request('/admin/audit-logs', admin.token)).status,
          403,
        );
      },
    );
  } finally {
    await cleanTicketFixtures(users, categoryId);
    await prisma.subscriptionPlan.deleteMany({
      where: { id: { in: planIds } },
    });
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await disconnectDatabase();
  }
});
