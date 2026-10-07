import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Server } from 'node:http';
process.env.PUBLIC_SIGNUP_ROLE = 'BUYER';
process.env.EMAIL_QUEUE_NAME = `imet-payment-test-${randomUUID()}`;
process.env.SSLCOMMERZ_STORE_ID = 'test-merchant';
process.env.SSLCOMMERZ_STORE_PASSWORD = 'test-only-password';
process.env.PAYMENT_CALLBACK_ORIGIN = 'https://backend.example.test';
const { prisma, disconnectDatabase } =
  await import('../src/config/database.js');
const { default: app } = await import('../src/app.js');
const { sslcommerz } = await import('../src/modules/payment/sslcommerz.js');
const { paymentService } =
  await import('../src/modules/payment/payment.service.js');
const { authService } = await import('../src/modules/auth/auth.service.js');
const { newToken } = await import('../src/utils/tokens.js');
const { hashPassword } = await import('../src/utils/hashing.js');
const { getEmailQueue, closeEmailQueue } =
  await import('../src/emails/queue.js');
const { requireEntitlement } =
  await import('../src/modules/subscription/subscription.entitlements.js');
const { responseEntitlement } =
  await import('../src/modules/rfq/quote.service.js');
const profile = {
  companyName: 'Payment fixture machinery',
  type: 'LOCAL' as const,
  description: 'Industrial supplier company',
  contactName: 'Test Supplier',
  businessEmail: 'company@example.test',
  businessPhone: '+880123456789',
  address: '123 Industrial Road',
  city: 'Dhaka',
  country: 'Bangladesh',
  registrationNumber: null,
  website: null,
  logoUrl: null,
  documents: [],
};
test('supplier onboarding, authoritative payments, retries, concurrency, manual audit and authorization', async () => {
  const ids: string[] = [];
  const planIds: string[] = [];
  let server: Server | undefined;
  const original = { ...sslcommerz };
  let order: Awaited<ReturnType<typeof sslcommerz.validate>>;
  let queried: Awaited<ReturnType<typeof sslcommerz.query>> = [];
  let checkoutCalls = 0;
  sslcommerz.initiate = async () => {
    checkoutCalls++;
    return {
      gatewayUrl: 'https://sandbox.sslcommerz.com/checkout',
      sessionKey: `fixture-${checkoutCalls}`,
    };
  };
  sslcommerz.validate = async () => order;
  sslcommerz.query = async () => queried;
  try {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: `Payment plan ${randomUUID()}`,
        eligibleTypes: ['LOCAL'],
        durationDays: 28,
        price: '1234.50',
        currency: 'BDT',
        listingLimit: 5,
        imageLimit: 3,
        specificationLimit: 20,
        canPublishMachinery: true,
        rfqEnabled: true,
        leadLimitPerMonth: 10,
        canRevealContacts: true,
        visibility: 'STANDARD',
        isActive: true,
      },
    });
    planIds.push(plan.id);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const request = async (
      path: string,
      body?: unknown,
      token?: string,
      method?: string,
    ) => {
      const response = await fetch(`${base}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        body: response.status === 303 ? {} : await response.json(),
      };
    };
    const email = `payment-${randomUUID()}@example.test`,
      password = 'PaymentFixture123!';
    assert.equal(
      (
        await request('/auth/register-supplier', {
          displayName: 'Fixture Supplier',
          email,
          password,
          profile,
          planId: plan.id,
        })
      ).status,
      200,
    );
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { supplier: true },
    });
    ids.push(user.id);
    assert.ok(user.supplier);
    assert.equal(user.status, 'PENDING');
    assert.equal(
      (await request('/auth/login', { email, password })).status,
      403,
    );
    const jobs = await getEmailQueue().getJobs(['waiting', 'delayed']);
    const job = jobs.find((j) => j.data.to === email);
    assert.ok(job, 'durable verification email');
    const raw = new URL(
      job.data.html.match(/href="([^"]+)"/)![1].replaceAll('&amp;', '&'),
    ).searchParams.get('token');
    assert.ok(raw);
    assert.equal(
      (await request('/auth/verify-user', { token: raw })).status,
      200,
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      'PENDING',
    );
    assert.equal(
      (await request('/auth/verify-user', { token: raw })).status,
      400,
    );
    const auth = await authService.login(email, password);
    assert.equal(
      (await request('/auth/me', undefined, auth.accessToken)).status,
      200,
    );
    assert.equal(
      (await request('/supplier/me', undefined, auth.accessToken)).status,
      403,
    );
    assert.equal(
      (await request('/leads', undefined, auth.accessToken)).status,
      403,
    );
    await assert.rejects(
      prisma.$transaction((tx) => responseEntitlement(tx, user.id)),
    );
    await assert.rejects(
      prisma.$transaction((tx) =>
        requireEntitlement(tx, user.supplier!.id, {
          userId: user.id,
          publishing: true,
        }),
      ),
    );
    assert.equal(
      (await request('/payments/onboarding', undefined, auth.accessToken))
        .status,
      200,
    );
    assert.equal(
      (
        await request(
          '/payments/checkout',
          { planId: plan.id, idempotencyKey: randomUUID(), amount: '1.00' },
          auth.accessToken,
        )
      ).status,
      422,
    );
    const key = randomUUID();
    const first = await paymentService.checkout(user.id, {
      planId: plan.id,
      idempotencyKey: key,
    });
    assert.equal(first.amount.toString(), '1234.5');
    assert.equal(
      (
        await paymentService.checkout(user.id, {
          planId: plan.id,
          idempotencyKey: key,
        })
      ).id,
      first.id,
    );
    assert.equal(checkoutCalls, 1);
    assert.equal(
      (
        await request(
          '/payments/checkout',
          { planId: plan.id, idempotencyKey: randomUUID() },
          auth.accessToken,
        )
      ).status,
      409,
    );
    assert.equal((await request(`/payments/${first.id}`)).status, 401);
    const buyer = await prisma.user.create({
      data: {
        email: `buyer-${randomUUID()}@example.test`,
        displayName: 'Buyer fixture',
        password: await hashPassword(password),
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { create: { role: 'BUYER' } },
      },
    });
    ids.push(buyer.id);
    const buyerAuth = await authService.login(buyer.email, password);
    assert.equal(
      (await request(`/payments/${first.id}`, undefined, buyerAuth.accessToken))
        .status,
      404,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${user.supplier.id}/activate`,
          {},
          buyerAuth.accessToken,
        )
      ).status,
      403,
    );
    order = {
      status: 'VALID',
      tran_id: first.transactionId,
      val_id: `v-${randomUUID()}`,
      amount: '1.00',
      currency: 'BDT',
      risk_level: '0',
    };
    assert.equal(
      (
        await request('/payments/ipn', {
          tran_id: first.transactionId,
          val_id: order.val_id,
          amount: '1234.50',
          status: 'VALID',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
      'PENDING',
    );
    order = { ...order, amount: '1234.50', currency: 'USD' };
    assert.equal(
      (
        await request('/payments/ipn', {
          tran_id: first.transactionId,
          val_id: order.val_id,
        })
      ).status,
      400,
    );
    order = { ...order, currency: 'BDT', tran_id: `imet_${'a'.repeat(24)}` };
    assert.equal(
      (
        await request('/payments/ipn', {
          tran_id: first.transactionId,
          val_id: order.val_id,
        })
      ).status,
      400,
    );
    order = {
      ...order,
      tran_id: first.transactionId,
      status: 'INVALID_TRANSACTION',
    };
    assert.equal(
      (
        await request('/payments/ipn', {
          tran_id: first.transactionId,
          val_id: order.val_id,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request('/payments/callback/success', {
          tran_id: first.transactionId,
          val_id: order.val_id,
        })
      ).status,
      303,
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      'PENDING',
    );
    order = { ...order, status: 'VALID' };
    const duplicates = await Promise.all([
      request('/payments/ipn', {
        tran_id: first.transactionId,
        val_id: order.val_id,
      }),
      request('/payments/ipn', {
        tran_id: first.transactionId,
        val_id: order.val_id,
      }),
    ]);
    assert.deepEqual(
      duplicates.map((r) => r.status),
      [200, 200],
    );
    let terms = await prisma.supplierSubscription.findMany({
      where: { supplierId: user.supplier.id },
    });
    assert.equal(terms.length, 1);
    assert.equal(terms[0].state, 'ACTIVE');
    assert.equal(terms[0].activationMethod, 'PAYMENT');
    const originalEnd = terms[0].endsAt.toISOString();
    await request('/payments/ipn', {
      tran_id: first.transactionId,
      val_id: order.val_id,
    });
    terms = await prisma.supplierSubscription.findMany({
      where: { supplierId: user.supplier.id },
    });
    assert.equal(terms[0].endsAt.toISOString(), originalEnd);
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).status,
      'ACTIVE',
    );
    assert.equal(
      (await request('/supplier/me', undefined, auth.accessToken)).status,
      200,
    );
    await prisma.$transaction(async (tx) => {
      await responseEntitlement(tx, user.id);
      await requireEntitlement(tx, user.supplier!.id, {
        userId: user.id,
        publishing: true,
      });
    });
    assert.equal((await request(`/suppliers/${user.supplier.id}`)).status, 200);
    assert.equal(
      (
        await request(
          '/payments/checkout',
          { planId: plan.id, idempotencyKey: randomUUID() },
          auth.accessToken,
        )
      ).status,
      409,
    );
    const createPending = async () => {
      const u = await prisma.user.create({
        data: {
          email: `pending-${randomUUID()}@example.test`,
          displayName: 'Pending fixture',
          password: await hashPassword(password),
          status: 'PENDING',
          isEmailVerified: true,
          supplier: { create: profile },
          assignedRole: { create: { role: 'LOCAL_SUPPLIER' } },
        },
        include: { supplier: true },
      });
      ids.push(u.id);
      assert.ok(u.supplier);
      return u;
    };
    const retryUser = await createPending();
    let retry = await paymentService.checkout(retryUser.id, {
      planId: plan.id,
      idempotencyKey: randomUUID(),
    });
    // A browser/IPN claim of cancellation alone is insufficient: only server lookup can confirm it.
    queried = [];
    assert.equal(
      (
        await request('/payments/ipn', {
          tran_id: retry.transactionId,
          status: 'CANCELLED',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await prisma.paymentTransaction.findUniqueOrThrow({
          where: { id: retry.id },
        })
      ).status,
      'PENDING',
    );
    for (const terminal of ['FAILED', 'CANCELLED', 'EXPIRED'] as const) {
      queried = [{ tran_id: retry.transactionId, status: terminal }];
      await paymentService.notify(retry.transactionId);
      assert.equal(
        (
          await prisma.paymentTransaction.findUniqueOrThrow({
            where: { id: retry.id },
          })
        ).status,
        terminal,
      );
      retry = await paymentService.checkout(retryUser.id, {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      });
    }
    assert.equal(
      await prisma.supplierSubscription.count({
        where: { supplierId: retryUser.supplier!.id },
      }),
      1,
    );
    order = {
      status: 'VALID',
      tran_id: retry.transactionId,
      val_id: `v-${randomUUID()}`,
      amount: '1234.50',
      currency: 'BDT',
      risk_level: '1',
    };
    await paymentService.notify(retry.transactionId, order.val_id);
    assert.equal(
      (await paymentService.get(retryUser.id, retry.id)).status,
      'REVIEW',
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: retryUser.id } }))
        .status,
      'PENDING',
    );
    await assert.rejects(
      paymentService.checkout(retryUser.id, {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      }),
    );
    const blocked = await createPending(),
      blockedPayment = await paymentService.checkout(blocked.id, {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      });
    await prisma.user.update({
      where: { id: blocked.id },
      data: { status: 'SUSPENDED' },
    });
    order = {
      ...order,
      tran_id: blockedPayment.transactionId,
      val_id: `v-${randomUUID()}`,
      risk_level: '0',
    };
    await paymentService.notify(blockedPayment.transactionId, order.val_id);
    assert.equal(
      (await paymentService.get(blocked.id, blockedPayment.id)).status,
      'REVIEW',
    );
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: blocked.id } }))
        .status,
      'SUSPENDED',
    );
    const admin = await prisma.user.create({
      data: {
        email: `admin-${randomUUID()}@example.test`,
        displayName: 'Admin fixture',
        password: await hashPassword(password),
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { create: { role: 'ADMIN' } },
      },
    });
    ids.push(admin.id);
    const adminAuth = await authService.login(admin.email, password),
      manualUser = await createPending();
    const before = await prisma.supplier.findUniqueOrThrow({
      where: { userId: manualUser.id },
    });
    const manualData = {
      planId: plan.id,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 28 * 86400000).toISOString(),
      reason: 'Approved offline supplier activation',
      confirmed: true as const,
      updatedAt: before.updatedAt.toISOString(),
      expectedCurrentId: null,
      expectedCurrentUpdatedAt: null,
    };
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/activate`,
          { ...manualData, reason: '' },
          adminAuth.accessToken,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/activate`,
          { ...manualData, confirmed: false },
          adminAuth.accessToken,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/activate`,
          manualData,
          buyerAuth.accessToken,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/activate`,
          manualData,
          adminAuth.accessToken,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/activate`,
          manualData,
          adminAuth.accessToken,
        )
      ).status,
      409,
    );
    assert.equal(
      await prisma.paymentTransaction.count({
        where: { userId: manualUser.id },
      }),
      0,
    );
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: admin.id, action: 'SUPPLIER_MANUAL_ACTIVATION' },
    });
    assert.ok(JSON.stringify(audit.context).includes(manualData.reason));
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: manualUser.id } }))
        .status,
      'ACTIVE',
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${before.id}/payments`,
          undefined,
          adminAuth.accessToken,
        )
      ).status,
      200,
    );
    const raceUser = await createPending(),
      racePayment = await paymentService.checkout(raceUser.id, {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      });
    const raceSupplier = await prisma.supplier.findUniqueOrThrow({
      where: { userId: raceUser.id },
      include: { subscriptions: { where: { isCurrent: true } } },
    });
    await paymentService.manual(admin.id, raceSupplier.id, {
      ...manualData,
      updatedAt: raceSupplier.updatedAt.toISOString(),
      expectedCurrentId: raceSupplier.subscriptions[0].id,
      expectedCurrentUpdatedAt:
        raceSupplier.subscriptions[0].updatedAt.toISOString(),
    });
    order = {
      ...order,
      tran_id: racePayment.transactionId,
      val_id: `v-${randomUUID()}`,
    };
    await paymentService.notify(racePayment.transactionId, order.val_id);
    assert.equal(
      (await paymentService.get(raceUser.id, racePayment.id)).status,
      'REVIEW',
    );
    assert.equal(
      await prisma.supplierSubscription.count({
        where: {
          supplierId: raceSupplier.id,
          isCurrent: true,
          activationMethod: 'ADMIN_MANUAL',
        },
      }),
      1,
    );
    const repriced = await createPending(),
      pricePayment = await paymentService.checkout(repriced.id, {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      });
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: { price: '2222.00', name: 'Updated plan' },
    });
    assert.equal(
      (await request('/subscriptions/plans')).body.data.find(
        (p: { id: string }) => p.id === plan.id,
      ).price,
      '2222',
    );
    order = {
      ...order,
      tran_id: pricePayment.transactionId,
      val_id: `v-${randomUUID()}`,
      amount: '1234.50',
    };
    await paymentService.notify(pricePayment.transactionId, order.val_id);
    assert.equal(
      (
        await paymentService.get(repriced.id, pricePayment.id)
      ).amount.toString(),
      '1234.5',
    );
    await prisma.subscriptionPlan.update({
      where: { id: plan.id },
      data: { isActive: false },
    });
    assert.equal(
      (await request('/subscriptions/plans')).body.data.some(
        (p: { id: string }) => p.id === plan.id,
      ),
      false,
    );
    const unverifiedToken = newToken();
    const recovering = await createPending();
    await authService.forgot(recovering.email);
    assert.ok(
      (await prisma.user.findUniqueOrThrow({ where: { id: recovering.id } }))
        .passwordResetTokenHash,
    );
    await prisma.user.update({
      where: { id: recovering.id },
      data: {
        passwordResetTokenHash: unverifiedToken.hash,
        passwordResetExpires: new Date(Date.now() + 60000),
      },
    });
    await authService.reset(unverifiedToken.raw, 'ChangedPayment123!');
    const renewed = await authService.login(
      recovering.email,
      'ChangedPayment123!',
    );
    assert.equal(
      (await authService.refresh(renewed.refreshToken)).user.status,
      'PENDING',
    );
  } finally {
    Object.assign(sslcommerz, original);
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
    const queue = getEmailQueue();
    await queue.obliterate({ force: true });
    await closeEmailQueue();
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.paymentTransaction.deleteMany({
      where: { userId: { in: ids } },
    });
    await prisma.supplierSubscription.deleteMany({
      where: { supplier: { userId: { in: ids } } },
    });
    await prisma.supplier.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.subscriptionPlan.deleteMany({
      where: { id: { in: planIds } },
    });
    await disconnectDatabase();
  }
});
