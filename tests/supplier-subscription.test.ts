import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { effectiveState } from '../src/modules/subscription/subscription.entitlements.js';

test('subscription effective state handles exact boundaries and manual states', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const active = {
    state: 'ACTIVE' as const,
    startsAt: new Date('2025-12-31T00:00:00Z'),
    endsAt: new Date('2026-01-02T00:00:00Z'),
  };
  assert.equal(effectiveState(active, now), 'ACTIVE');
  assert.equal(effectiveState({ ...active, startsAt: now }, now), 'ACTIVE');
  assert.equal(effectiveState({ ...active, endsAt: now }, now), 'EXPIRED');
  assert.equal(
    effectiveState({ ...active, startsAt: new Date(now.getTime() + 1) }, now),
    'PENDING',
  );
  assert.equal(effectiveState({ ...active, state: 'PENDING' }, now), 'PENDING');
  assert.equal(
    effectiveState({ ...active, state: 'SUSPENDED' }, now),
    'SUSPENDED',
  );
  assert.equal(
    effectiveState({ ...active, state: 'CANCELLED' }, now),
    'CANCELLED',
  );
});

test('supplier approval, manual subscriptions, privacy, ownership, quota races, renewals and public expiry', async () => {
  const key = `m4-${randomUUID()}`;
  const users: string[] = [];
  const plans: string[] = [];
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const request = async (
    path: string,
    method = 'GET',
    body?: unknown,
    token?: string,
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const account = async (role: 'ADMIN' | 'BUYER') => {
    const user = await prisma.user.create({
      data: {
        email: `${key}-${users.length}@example.test`,
        displayName: 'Supplier Test',
        password: 'Unusable fixture hash',
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
    users.push(user.id);
    return {
      id: user.id,
      token: signAccessToken(user.id, user.sessions[0].id),
    };
  };
  try {
    const admin = await account('ADMIN');
    const buyer = await account('BUYER');
    const other = await account('BUYER');
    const profile = {
      companyName: key,
      type: 'LOCAL',
      description: 'Public company overview',
      contactName: 'Private Contact',
      businessEmail: `${key}@example.test`,
      businessPhone: '+880123456789',
      address: 'Private street address',
      city: 'Dhaka',
      country: 'Bangladesh',
      registrationNumber: 'Private verification number',
      website: 'https://example.com',
      logoUrl: null,
      documents: [
        {
          name: 'Private registration certificate',
          url: 'https://example.test/private-document.pdf',
        },
      ],
    };
    assert.equal(
      (await request('/supplier/applications', 'POST', profile)).status,
      401,
    );
    assert.equal(
      (await request('/admin/suppliers', 'GET', undefined, buyer.token)).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/admin/subscriptions/plans',
          'GET',
          undefined,
          buyer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/supplier/applications',
          'POST',
          { ...profile, status: 'APPROVED' },
          buyer.token,
        )
      ).status,
      422,
    );
    const application = await request(
      '/supplier/applications',
      'POST',
      profile,
      buyer.token,
    );
    assert.equal(application.status, 201);
    let supplier = application.body.data;
    assert.equal(supplier.status, 'PENDING');
    assert.equal((await request(`/suppliers/${supplier.id}`)).status, 404);
    assert.equal(
      (await request('/supplier/applications', 'POST', profile, buyer.token))
        .status,
      409,
    );
    assert.equal(
      (await request('/supplier/me', 'GET', undefined, other.token)).body.data,
      null,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}`,
          'GET',
          undefined,
          other.token,
        )
      ).status,
      403,
    );
    const pendingEdit = {
      description: 'Updated public description',
      contactName: profile.contactName,
      businessEmail: profile.businessEmail,
      businessPhone: profile.businessPhone,
      website: profile.website,
      logoUrl: null,
      updatedAt: supplier.updatedAt,
    };
    assert.equal(
      (await request('/supplier/me', 'PUT', pendingEdit, buyer.token)).status,
      403,
    );
    const review = async (status: string, visible = true) => {
      const response = await request(
        `/admin/suppliers/${supplier.id}/review`,
        'PATCH',
        {
          status,
          isVerified: true,
          marketplaceVisible: visible,
          reviewNote:
            status === 'REJECTED'
              ? 'Please provide updated documentation'
              : null,
          updatedAt: supplier.updatedAt,
        },
        admin.token,
      );
      assert.equal(response.status, 200);
      supplier = response.body.data;
    };
    await review('REJECTED');
    const resubmit = await request(
      '/supplier/applications',
      'POST',
      profile,
      buyer.token,
    );
    assert.equal(resubmit.status, 201);
    supplier = resubmit.body.data;
    assert.equal(supplier.isVerified, false);
    await review('APPROVED');
    const roles = await prisma.userRoleAssignment.findMany({
      where: { userId: buyer.id },
    });
    assert.ok(roles.some((role) => role.role === 'LOCAL_SUPPLIER'));
    assert.ok(roles.some((role) => role.role === 'BUYER'));
    const planData = {
      name: key,
      eligibleTypes: ['LOCAL'],
      durationDays: 30,
      price: '1250.50',
      currency: 'BDT',
      listingLimit: 1,
      imageLimit: 1,
      specificationLimit: 2,
      canPublishMachinery: true,
      visibility: 'FEATURED',
      isActive: true,
    };
    for (const bad of [
      { ...planData, price: '-1' },
      { ...planData, price: '1.999' },
      { ...planData, durationDays: 0 },
      { ...planData, listingLimit: 0 },
      { ...planData, eligibleTypes: [] },
      { ...planData, currency: 'invalid' },
    ])
      assert.equal(
        (await request('/admin/subscriptions/plans', 'POST', bad, admin.token))
          .status,
        422,
      );
    const createdPlan = await request(
      '/admin/subscriptions/plans',
      'POST',
      planData,
      admin.token,
    );
    assert.equal(createdPlan.status, 201);
    let plan = createdPlan.body.data;
    plans.push(plan.id);
    const category = await prisma.machineCategory.create({
      data: { name: key, slug: key },
    });
    const machineData = {
      name: key,
      slug: key,
      description: 'Industrial test machinery',
      manufacturer: 'Test Maker',
      model: 'M4',
      categoryId: category.id,
      status: 'PUBLISHED',
      images: [{ url: 'https://example.com/image.jpg', alt: 'Front' }],
      specifications: [{ label: 'Power', value: '5 kW' }],
    };
    assert.equal(
      (
        await request(
          '/supplier/catalogue/machines',
          'POST',
          machineData,
          buyer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          '/admin/catalogue/machines',
          'POST',
          { ...machineData, supplierId: supplier.id },
          admin.token,
        )
      ).status,
      403,
      'admin publication must enforce supplier subscription eligibility',
    );
    const dates = {
      startsAt: new Date(Date.now() - 60000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      state: 'ACTIVE',
      expectedCurrentId: null,
      expectedCurrentUpdatedAt: null,
    };
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}/subscriptions`,
          'POST',
          { ...dates, planId: plan.id },
          buyer.token,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}/subscriptions`,
          'POST',
          { ...dates, planId: plan.id, endsAt: dates.startsAt },
          admin.token,
        )
      ).status,
      422,
    );
    const assigned = await request(
      `/admin/suppliers/${supplier.id}/subscriptions`,
      'POST',
      { ...dates, planId: plan.id },
      admin.token,
    );
    assert.equal(assigned.status, 201);
    let term = assigned.body.data;
    assert.equal(term.effectiveStatus, 'ACTIVE');
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}/subscriptions`,
          'POST',
          { ...dates, planId: plan.id },
          admin.token,
        )
      ).status,
      409,
      'a stale first-assignment view must not replace the new term',
    );
    const own = await request('/supplier/me', 'GET', undefined, buyer.token);
    assert.equal(own.body.data.businessEmail, profile.businessEmail);
    const updateProfile = { ...pendingEdit, updatedAt: supplier.updatedAt };
    assert.equal(
      (
        await request(
          '/supplier/me',
          'PUT',
          { ...updateProfile, isVerified: true },
          buyer.token,
        )
      ).status,
      422,
    );
    const ownSaved = await request(
      '/supplier/me',
      'PUT',
      updateProfile,
      buyer.token,
    );
    assert.equal(ownSaved.status, 200);
    supplier = ownSaved.body.data;
    assert.equal(
      (await request('/supplier/me', 'PUT', updateProfile, buyer.token)).status,
      409,
    );
    const publicSupplier = await request(`/suppliers/${supplier.id}`);
    assert.equal(publicSupplier.status, 200);
    const encoded = JSON.stringify(publicSupplier.body.data);
    for (const secret of [
      profile.businessEmail,
      profile.businessPhone,
      profile.address,
      profile.registrationNumber,
      profile.documents[0].url,
      profile.contactName,
    ])
      assert.equal(encoded.includes(secret), false);
    assert.deepEqual(Object.keys(publicSupplier.body.data).sort(), [
      'city',
      'companyName',
      'country',
      'description',
      'id',
      'isVerified',
      'logoUrl',
      'type',
      'visibility',
      'website',
    ]);
    assert.equal(publicSupplier.body.data.visibility, 'FEATURED');
    assert.equal(
      (
        await request(
          '/supplier/catalogue/machines',
          'POST',
          { ...machineData, supplierId: randomUUID() },
          buyer.token,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await request(
          '/supplier/catalogue/machines',
          'POST',
          {
            ...machineData,
            images: [...machineData.images, ...machineData.images],
          },
          buyer.token,
        )
      ).status,
      403,
    );
    const race = await Promise.all([
      request('/supplier/catalogue/machines', 'POST', machineData, buyer.token),
      request(
        '/supplier/catalogue/machines',
        'POST',
        { ...machineData, slug: `${key}-other` },
        buyer.token,
      ),
    ]);
    assert.deepEqual(race.map((result) => result.status).sort(), [201, 403]);
    let machine = race.find((result) => result.status === 201)!.body.data;
    const lowPlan = await request(
      '/admin/subscriptions/plans',
      'POST',
      { ...planData, name: `${key}-low`, imageLimit: 0 },
      admin.token,
    );
    assert.equal(lowPlan.status, 201);
    plans.push(lowPlan.body.data.id);
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}/subscriptions`,
          'POST',
          {
            ...dates,
            planId: lowPlan.body.data.id,
            expectedCurrentId: term.id,
            expectedCurrentUpdatedAt: term.updatedAt,
          },
          admin.token,
        )
      ).status,
      409,
      'renewal cannot lower limits below existing content',
    );
    assert.equal(
      await prisma.supplierSubscription.count({
        where: { supplierId: supplier.id, isCurrent: true },
      }),
      1,
    );
    assert.equal(
      (
        await request(
          '/admin/catalogue/machines',
          'POST',
          { ...machineData, slug: `${key}-admin`, supplierId: supplier.id },
          admin.token,
        )
      ).status,
      403,
      'admin must not bypass supplier quota',
    );
    assert.equal(machine.supplierId, supplier.id);
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      200,
    );
    const filtered = await request(
      `/catalogue/machines?supplier=${supplier.id}&q=Industrial`,
    );
    assert.equal(filtered.body.data.pagination.total, 1);
    const otherProfile = await request(
      '/supplier/applications',
      'POST',
      { ...profile, companyName: `${key}-other`, type: 'INTERNATIONAL' },
      other.token,
    );
    assert.equal(otherProfile.status, 201);
    const otherSupplier = otherProfile.body.data;
    const otherReview = await request(
      `/admin/suppliers/${otherSupplier.id}/review`,
      'PATCH',
      {
        status: 'APPROVED',
        isVerified: false,
        marketplaceVisible: true,
        reviewNote: null,
        updatedAt: otherSupplier.updatedAt,
      },
      admin.token,
    );
    assert.equal(otherReview.status, 200);
    assert.equal(
      (
        await request(
          `/admin/suppliers/${otherSupplier.id}/subscriptions`,
          'POST',
          { ...dates, planId: plan.id },
          admin.token,
        )
      ).status,
      409,
      'plan type must match supplier',
    );
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { ...machineData, updatedAt: machine.updatedAt }],
      ['DELETE', { updatedAt: machine.updatedAt }],
    ] as const)
      assert.equal(
        (
          await request(
            `/supplier/catalogue/machines/${machine.id}`,
            method,
            body,
            other.token,
          )
        ).status,
        404,
      );
    const changedPlan = await request(
      `/admin/subscriptions/plans/${plan.id}`,
      'PUT',
      {
        ...planData,
        listingLimit: 2,
        price: '2000',
        isActive: false,
        updatedAt: plan.updatedAt,
      },
      admin.token,
    );
    assert.equal(changedPlan.status, 200);
    plan = changedPlan.body.data;
    assert.equal(
      (await request('/supplier/me', 'GET', undefined, buyer.token)).body.data
        .subscriptions[0].listingLimit,
      1,
      'assigned limits must remain unchanged',
    );
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      200,
      'plan deactivation stops future assignments, not existing terms',
    );
    assert.equal(
      (
        await request(
          `/admin/suppliers/${supplier.id}/subscriptions`,
          'POST',
          {
            ...dates,
            planId: plan.id,
            expectedCurrentId: term.id,
            expectedCurrentUpdatedAt: term.updatedAt,
          },
          admin.token,
        )
      ).status,
      409,
    );
    const updateTerm = async (
      state: string,
      startsAt = dates.startsAt,
      endsAt = dates.endsAt,
    ) => {
      const response = await request(
        `/admin/subscriptions/${term.id}`,
        'PUT',
        { startsAt, endsAt, state, updatedAt: term.updatedAt },
        admin.token,
      );
      assert.equal(response.status, 200);
      term = response.body.data;
    };
    await updateTerm('SUSPENDED');
    assert.equal((await request(`/suppliers/${supplier.id}`)).status, 404);
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    assert.equal(
      (
        await request(
          '/supplier/catalogue/machines',
          'POST',
          { ...machineData, slug: `key-new` },
          buyer.token,
        )
      ).status,
      403,
    );
    await updateTerm(
      'ACTIVE',
      new Date(Date.now() + 60000).toISOString(),
      new Date(Date.now() + 120000).toISOString(),
    );
    assert.equal(term.effectiveStatus, 'PENDING');
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    await updateTerm(
      'ACTIVE',
      new Date(Date.now() - 120000).toISOString(),
      new Date(Date.now() - 60000).toISOString(),
    );
    assert.equal(term.effectiveStatus, 'EXPIRED');
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    await updateTerm('ACTIVE');
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      200,
    );
    await review('SUSPENDED');
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    await review('APPROVED', false);
    assert.equal((await request(`/suppliers/${supplier.id}`)).status, 404);
    await review('APPROVED', true);
    await prisma.user.update({
      where: { id: buyer.id },
      data: { status: 'SUSPENDED' },
    });
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    await prisma.user.update({
      where: { id: buyer.id },
      data: { status: 'ACTIVE' },
    });
    const reactivate = await request(
      `/admin/subscriptions/plans/${plan.id}`,
      'PUT',
      { ...planData, listingLimit: 2, updatedAt: plan.updatedAt },
      admin.token,
    );
    assert.equal(reactivate.status, 200);
    plan = reactivate.body.data;
    const renew = await request(
      `/admin/suppliers/${supplier.id}/subscriptions`,
      'POST',
      {
        ...dates,
        planId: plan.id,
        expectedCurrentId: term.id,
        expectedCurrentUpdatedAt: term.updatedAt,
      },
      admin.token,
    );
    assert.equal(renew.status, 201);
    term = renew.body.data;
    assert.equal(term.listingLimit, 2);
    const replacement = {
      ...dates,
      planId: plan.id,
      expectedCurrentId: term.id,
      expectedCurrentUpdatedAt: term.updatedAt,
    };
    const renewRace = await Promise.all([
      request(
        `/admin/suppliers/${supplier.id}/subscriptions`,
        'POST',
        replacement,
        admin.token,
      ),
      request(
        `/admin/suppliers/${supplier.id}/subscriptions`,
        'POST',
        replacement,
        admin.token,
      ),
    ]);
    assert.deepEqual(
      renewRace.map((response) => response.status).sort(),
      [201, 409],
    );
    term = renewRace.find((response) => response.status === 201)!.body.data;

    const history = await prisma.supplierSubscription.findMany({
      where: { supplierId: supplier.id },
    });
    assert.equal(history.filter((t) => t.isCurrent).length, 1);
    assert.equal(history.find((t) => !t.isCurrent)?.state, 'CANCELLED');
    const edit = await request(
      `/supplier/catalogue/machines/${machine.id}`,
      'PUT',
      {
        ...machineData,
        slug: machine.slug,
        status: 'DRAFT',
        updatedAt: machine.updatedAt,
      },
      buyer.token,
    );
    assert.equal(edit.status, 200);
    machine = edit.body.data;
    assert.equal(
      (await request(`/catalogue/machines/${machine.slug}`)).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/supplier/catalogue/machines/${machine.id}`,
          'DELETE',
          { updatedAt: machine.updatedAt },
          buyer.token,
        )
      ).status,
      200,
    );
  } finally {
    const supplierIds = (
      await prisma.supplier.findMany({
        where: { userId: { in: users } },
        select: { id: true },
      })
    ).map((s) => s.id);
    await prisma.machine.deleteMany({
      where: {
        OR: [
          { supplierId: { in: supplierIds } },
          { slug: { startsWith: key } },
        ],
      },
    });
    await prisma.supplierSubscription.deleteMany({
      where: { supplierId: { in: supplierIds } },
    });
    await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    await prisma.subscriptionPlan.deleteMany({ where: { id: { in: plans } } });
    await prisma.machineCategory.deleteMany({ where: { slug: key } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
});
