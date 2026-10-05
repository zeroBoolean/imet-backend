import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Server } from 'node:http';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { bunnyStorage } from '../src/services/bunnyStorage.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { panoramaFixture } from './helpers/mediaFixtures.js';
import { supplierAssetService } from '../src/modules/supplier/supplier.assets.service.js';

test('supplier managed files enforce ownership, private documents, public eligibility, expiry and cleanup', async (t) => {
  const marker = `m4-assets-${randomUUID()}`,
    users: string[] = [],
    stored = new Map<string, Buffer>();
  let server: Server | undefined;
  let planId: string | undefined;
  let categoryId: string | undefined;
  let fault = false;
  let revoke: string | undefined;
  let hide: string | undefined;
  t.mock.method(bunnyStorage, 'isConfigured', () => true);
  t.mock.method(
    bunnyStorage,
    'request',
    async (key: string, method: string, body?: Buffer) => {
      assert.match(key, /^(supplier|catalogue)\//);
      if (fault) throw new Error('Fixture storage unavailable');
      if (method === 'PUT') {
        stored.set(key, Buffer.from(body!));
        if (revoke)
          await prisma.userSession.update({
            where: { id: revoke },
            data: { revokedAt: new Date() },
          });
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        stored.delete(key);
        return new Response(null);
      }
      if (hide)
        await prisma.supplier.update({
          where: { id: hide },
          data: { marketplaceVisible: false },
        });
      return new Response(new Uint8Array(stored.get(key)!));
    },
  );
  try {
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const a = server.address();
    assert.ok(a && typeof a !== 'string');
    const base = `http://127.0.0.1:${a.port}/api/v1`;
    const account = async (role: 'ADMIN' | 'BUYER') => {
      const u = await prisma.user.create({
        data: {
          email: `${marker}-${users.length}@example.test`,
          displayName: 'Assets fixture',
          password: 'unusable',
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
      return {
        id: u.id,
        session: u.sessions[0].id,
        token: signAccessToken(u.id, u.sessions[0].id),
      };
    };
    const admin = await account('ADMIN'),
      owner = await account('BUYER'),
      other = await account('BUYER');
    const call = async (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
    ) => {
      const r = await fetch(base + path, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    };
    const upload = async (
      path: string,
      token?: string,
      bytes = panoramaFixture(48, 48),
      name = 'logo.png',
    ) => {
      const body = new FormData();
      body.append('file', new Blob([new Uint8Array(bytes)]), name);
      const r = await fetch(base + path, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body,
      });
      return { status: r.status, body: await r.json() };
    };
    const bytes = async (path: string, token?: string) =>
      (
        await fetch(base + path, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
      ).status;
    assert.equal((await upload('/supplier/assets/LOGO')).status, 401);
    assert.equal(
      (
        await upload(
          '/supplier/assets/LOGO',
          owner.token,
          Buffer.from('<svg/>'),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await upload(
          '/supplier/assets/DOCUMENT',
          owner.token,
          Buffer.from('%PDF-1.7 incomplete'),
          'truncated.pdf',
        )
      ).status,
      422,
    );
    const logo = await upload('/supplier/assets/LOGO', owner.token),
      document = await upload(
        '/supplier/assets/DOCUMENT',
        owner.token,
        Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'),
        'certificate.pdf',
      );
    assert.equal(logo.status, 201);
    assert.equal(document.status, 201);
    const logoId = logo.body.data.assetId,
      docId = document.body.data.assetId;
    assert.equal(await bytes(`/supplier/assets/${docId}/content`), 401);
    assert.equal(
      await bytes(`/supplier/assets/${docId}/content`, other.token),
      404,
    );
    assert.equal(
      await bytes(`/supplier/assets/${docId}/content`, admin.token),
      404,
      'admins cannot read another uploader staged files',
    );
    assert.equal(await bytes(`/suppliers/assets/${docId}/logo`), 404);
    const profile = {
      companyName: marker,
      type: 'LOCAL',
      description: 'Industrial supplier',
      contactName: 'Private name',
      businessEmail: 'private@example.test',
      businessPhone: '12345',
      address: 'Private street',
      city: 'Dhaka',
      country: 'Bangladesh',
      registrationNumber: null,
      website: null,
      logoUrl: logo.body.data.url,
      logoAssetId: logoId,
      documents: [
        { name: 'Certificate', url: document.body.data.url, assetId: docId },
      ],
    };
    assert.equal(
      (await call('/supplier/applications', 'POST', profile, other.token))
        .status,
      422,
      'foreign staged binding rejected',
    );
    assert.equal(
      await prisma.supplier.count({ where: { userId: other.id } }),
      0,
      'failed binding rolls back application',
    );
    const applied = await call(
      '/supplier/applications',
      'POST',
      profile,
      owner.token,
    );
    assert.equal(applied.status, 201);
    const id = applied.body.data.id;
    assert.equal(
      await bytes(`/supplier/assets/${docId}/content`, admin.token),
      200,
    );
    assert.equal(
      await bytes(`/supplier/assets/${docId}/content`, owner.token),
      200,
    );
    assert.equal(await bytes(`/suppliers/assets/${logoId}/logo`), 404);
    assert.equal(
      (await upload('/supplier/assets/DOCUMENT', owner.token)).status,
      403,
      'pending owner cannot change verification files',
    );
    assert.equal(
      (
        await call(
          `/supplier/assets/${logoId}`,
          'DELETE',
          undefined,
          owner.token,
        )
      ).status,
      404,
      'attached assets cannot be deleted directly',
    );
    assert.equal(
      (
        await call(
          `/admin/suppliers/${id}/review`,
          'PATCH',
          {
            status: 'APPROVED',
            isVerified: true,
            marketplaceVisible: true,
            reviewNote: null,
            updatedAt: applied.body.data.updatedAt,
          },
          other.token,
        )
      ).status,
      403,
    );
    const reviewed = await call(
      `/admin/suppliers/${id}/review`,
      'PATCH',
      {
        status: 'APPROVED',
        isVerified: true,
        marketplaceVisible: true,
        reviewNote: null,
        updatedAt: applied.body.data.updatedAt,
      },
      admin.token,
    );
    assert.equal(reviewed.status, 200);
    const plan = await call(
      '/admin/subscriptions/plans',
      'POST',
      {
        name: marker,
        eligibleTypes: ['LOCAL'],
        durationDays: 30,
        price: '123.45',
        currency: 'BDT',
        listingLimit: 1,
        imageLimit: 1,
        specificationLimit: 1,
        canPublishMachinery: true,
        rfqEnabled: true,
        leadLimitPerMonth: 10,
        canRevealContacts: true,
        visibility: 'STANDARD',
        isActive: true,
      },
      admin.token,
    );
    assert.equal(plan.status, 201);
    planId = plan.body.data.id;
    const assigned = await call(
      `/admin/suppliers/${id}/subscriptions`,
      'POST',
      {
        planId,
        state: 'ACTIVE',
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 86400000).toISOString(),
        expectedCurrentId: null,
        expectedCurrentUpdatedAt: null,
      },
      admin.token,
    );
    assert.equal(assigned.status, 201);
    assert.equal(await bytes(`/suppliers/assets/${logoId}/logo`), 200);
    const publicProfile = await call(`/suppliers/${id}`);
    assert.equal(publicProfile.status, 200);
    for (const field of [
      'businessEmail',
      'businessPhone',
      'contactName',
      'address',
      'documents',
      'logoAssetId',
    ])
      assert.equal(field in publicProfile.body.data, false);
    assert.equal(
      (await call(`/suppliers/${id}?include=documents`)).status,
      200,
    ); // Projection stays explicit even with guessed query.
    assert.equal(
      (await upload('/supplier/catalogue/image-uploads', other.token)).status,
      403,
    );
    const image = await upload(
      '/supplier/catalogue/image-uploads',
      owner.token,
    );
    assert.equal(image.status, 201);
    assert.equal(
      await bytes(
        `/supplier/catalogue/image-uploads/${image.body.data.assetId}/preview`,
        other.token,
      ),
      404,
    );
    categoryId = (
      await prisma.machineCategory.create({
        data: { name: marker, slug: marker },
      })
    ).id;
    const machine = {
      name: marker,
      slug: marker,
      description: 'Machine',
      manufacturer: 'Factory',
      model: 'A',
      categoryId,
      status: 'PUBLISHED',
      images: [
        {
          url: image.body.data.url,
          assetId: image.body.data.assetId,
          alt: 'Machine',
        },
      ],
      specifications: [],
    };
    assert.equal(
      (await call('/supplier/catalogue/machines', 'POST', machine, owner.token))
        .status,
      201,
    );
    const saved = await prisma.machine.findUniqueOrThrow({
      where: { slug: marker },
    });
    assert.equal(
      (
        await call(
          `/supplier/catalogue/machines/${saved.id}`,
          'PUT',
          {
            ...machine,
            updatedAt: saved.updatedAt.toISOString(),
            specifications: [
              { label: 'Power', value: '1 kW' },
              { label: 'Voltage', value: '240 V' },
            ],
          },
          owner.token,
        )
      ).status,
      403,
      'plan specification ceiling enforced on direct edit',
    );
    assert.equal(
      (
        await call(
          `/supplier/catalogue/machines/${saved.id}`,
          'PUT',
          {
            ...machine,
            updatedAt: saved.updatedAt.toISOString(),
            images: [
              ...machine.images,
              { url: 'https://example.test/extra.png', alt: 'Extra' },
            ],
          },
          owner.token,
        )
      ).status,
      403,
      'plan image ceiling enforced on direct edit',
    );
    assert.equal(
      (
        await call(
          `/supplier/catalogue/machines/${saved.id}`,
          'GET',
          undefined,
          other.token,
        )
      ).status,
      403,
      'ordinary buyer cannot read supplier management API',
    );
    assert.equal(
      await prisma.machineSpecification.count({
        where: { machineId: saved.id },
      }),
      0,
      'forbidden edits leave persisted data unchanged',
    );

    assert.equal(
      (
        await call(
          '/supplier/catalogue/machines',
          'POST',
          { ...machine, slug: `${marker}-second`, images: [] },
          owner.token,
        )
      ).status,
      403,
      'serialized plan listing ceiling',
    );
    assert.equal(
      await bytes(`/catalogue/images/${image.body.data.assetId}/content`),
      200,
    );
    await prisma.supplierSubscription.update({
      where: { id: assigned.body.data.id },
      data: { endsAt: new Date(Date.now() - 1000) },
    });
    assert.equal(
      (await upload('/supplier/catalogue/image-uploads', owner.token)).status,
      403,
      'expired plan cannot upload',
    );
    assert.equal(await bytes(`/suppliers/assets/${logoId}/logo`), 404);
    assert.equal(
      await bytes(`/catalogue/images/${image.body.data.assetId}/content`),
      404,
    );
    assert.equal(
      await bytes(`/supplier/assets/${docId}/content`, owner.token),
      200,
      'private history remains available',
    );
    assert.equal(
      (
        await call(
          '/supplier/catalogue/machines',
          'POST',
          { ...machine, slug: `${marker}-expired`, images: [] },
          owner.token,
        )
      ).status,
      403,
    );
    await prisma.supplierSubscription.update({
      where: { id: assigned.body.data.id },
      data: { endsAt: new Date(Date.now() + 86400000) },
    });
    hide = id;
    assert.equal(
      await bytes(`/suppliers/assets/${logoId}/logo`),
      404,
      'visibility revoked during file read',
    );
    hide = undefined;
    const replacement = await upload('/supplier/assets/LOGO', owner.token);
    assert.equal(replacement.status, 201);
    const before = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    const permitted = {
      description: 'Updated company',
      contactName: profile.contactName,
      businessEmail: profile.businessEmail,
      businessPhone: profile.businessPhone,
      website: null,
      logoUrl: replacement.body.data.url,
      logoAssetId: replacement.body.data.assetId,
      updatedAt: before.updatedAt.toISOString(),
    };
    const replaced = await call('/supplier/me', 'PUT', permitted, owner.token);
    assert.equal(
      replaced.status,
      200,
      'logo replacement must preserve optimistic version check',
    );
    assert.equal(
      (await prisma.supplierAsset.findUniqueOrThrow({ where: { id: logoId } }))
        .state,
      'DELETING',
    );
    assert.equal(
      (
        await call(
          '/supplier/me',
          'PUT',
          { ...permitted, description: 'Stale change' },
          owner.token,
        )
      ).status,
      409,
      'stale update cannot change newly bound asset',
    );
    assert.equal(
      (await prisma.supplier.findUniqueOrThrow({ where: { id } })).description,
      'Updated company',
    );
    assert.equal(
      (await prisma.supplierAsset.findUniqueOrThrow({ where: { id: docId } }))
        .state,
      'ACTIVE',
      'owner logo change preserves private verification files',
    );
    const adminDoc = await upload(
      '/supplier/assets/DOCUMENT',
      admin.token,
      panoramaFixture(80, 80),
      'admin-certificate.png',
    );
    assert.equal(adminDoc.status, 201);
    const fresh = await prisma.supplier.findUniqueOrThrow({ where: { id } });
    const adminEdit = await call(
      `/admin/suppliers/${id}`,
      'PUT',
      {
        ...profile,
        logoUrl: replacement.body.data.url,
        logoAssetId: replacement.body.data.assetId,
        documents: [
          {
            name: 'Admin certificate',
            url: adminDoc.body.data.url,
            assetId: adminDoc.body.data.assetId,
          },
        ],
        updatedAt: fresh.updatedAt.toISOString(),
      },
      admin.token,
    );
    assert.equal(adminEdit.status, 200);
    assert.equal(
      await bytes(
        `/supplier/assets/${adminDoc.body.data.assetId}/content`,
        owner.token,
      ),
      200,
      'owner can read admin-uploaded files bound to own company',
    );
    assert.equal(
      await bytes(
        `/supplier/assets/${adminDoc.body.data.assetId}/content`,
        other.token,
      ),
      404,
    );
    assert.equal(
      (await prisma.supplierAsset.findUniqueOrThrow({ where: { id: docId } }))
        .state,
      'DELETING',
      'admin replacement retires old document',
    );
    assert.equal(
      (
        await call(
          '/supplier/me',
          'PUT',
          {
            ...permitted,
            updatedAt: adminEdit.body.data.updatedAt,
            documents: [],
          },
          owner.token,
        )
      ).status,
      422,
      'owner cannot bypass sensitive document controls',
    );
    const staged = await upload('/supplier/assets/LOGO', other.token);
    assert.equal(staged.status, 201);
    fault = true;
    assert.equal(
      (
        await call(
          `/supplier/assets/${staged.body.data.assetId}`,
          'DELETE',
          undefined,
          other.token,
        )
      ).status,
      500,
    );
    fault = false;
    await supplierAssetService.cleanup();
    assert.equal(
      await prisma.supplierAsset.count({
        where: { id: staged.body.data.assetId },
      }),
      0,
    );
    revoke = other.session;
    assert.equal(
      (await upload('/supplier/assets/LOGO', other.token)).status,
      403,
      'session revoked during upload',
    );
    revoke = undefined;
  } finally {
    t.mock.restoreAll();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
    const suppliers = await prisma.supplier.findMany({
        where: { userId: { in: users } },
        select: { id: true },
      }),
      ids = suppliers.map((s) => s.id);
    await prisma.machineImage.deleteMany({
      where: { machine: { supplierId: { in: ids } } },
    });
    await prisma.machine.deleteMany({ where: { supplierId: { in: ids } } });
    await prisma.catalogueImageAsset.deleteMany({
      where: { ownerId: { in: users } },
    });
    await prisma.supplier.updateMany({
      where: { id: { in: ids } },
      data: { logoAssetId: null },
    });
    await prisma.supplierAsset.deleteMany({
      where: { ownerId: { in: users } },
    });
    await prisma.supplierSubscription.deleteMany({
      where: { supplierId: { in: ids } },
    });
    await prisma.supplier.deleteMany({ where: { id: { in: ids } } });
    if (planId)
      await prisma.subscriptionPlan.deleteMany({ where: { id: planId } });
    if (categoryId)
      await prisma.machineCategory.deleteMany({ where: { id: categoryId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.userRoleAssignment.deleteMany({
      where: { userId: { in: users } },
    });
    await prisma.userSession.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await disconnectDatabase();
  }
});
