import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { AppError } from '../src/middleware/errorHandler.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { bunnyStorage } from '../src/services/bunnyStorage.js';
import { catalogueAdminService } from '../src/modules/catalogue/catalogue.admin.service.js';
import { glbFixture, panoramaFixture } from './helpers/mediaFixtures.js';
import type { UserRole } from '../src/generated/client.js';
test('M9 media authorization, entitlement, delivery integrity, fallback metadata and retryable storage deletion', async (t) => {
  const marker = `media-test-${randomUUID()}`,
    users: string[] = [],
    storage = new Map<string, Buffer>();
  let failedPut = false,
    failedDelete = false;
  const mock = t.mock.method(
    bunnyStorage,
    'request',
    async (key: string, method: string, body?: Buffer) => {
      assert.match(key, /^machinery\//);
      if (method === 'PUT') {
        if (failedPut)
          throw new AppError('File storage is temporarily unavailable', 502);
        storage.set(key, body!);
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        if (failedDelete)
          throw new AppError('File storage is temporarily unavailable', 502);
        storage.delete(key);
        return new Response(null, { status: 204 });
      }
      const b = storage.get(key);
      return b
        ? new Response(new Uint8Array(b), {
            headers: { 'content-length': String(b.length) },
          })
        : new Response(null, { status: 404 });
    },
  );
  const configured = t.mock.method(bunnyStorage, 'isConfigured', () => true);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const account = async (role: UserRole) => {
    const u = await prisma.user.create({
      data: {
        email: `${marker}-${users.length}@example.test`,
        displayName: marker,
        password: 'fixture',
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
  const req = async (
    path: string,
    token?: string,
    method = 'GET',
    body?: FormData,
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      ...(body ? { body } : {}),
    });
    if (response.headers.get('content-type')?.includes('application/json'))
      return {
        status: response.status,
        data: await response.json(),
        buffer: null,
      };
    return {
      status: response.status,
      data: null,
      buffer: Buffer.from(await response.arrayBuffer()),
    };
  };
  const form = (type = 'MODEL_3D', buffer = glbFixture()) => {
    const body = new FormData();
    body.set('type', type);
    body.set('title', 'Technical inspection');
    body.set('file', new Blob([new Uint8Array(buffer)]), 'machine.glb');
    return body;
  };
  let categoryId: string | undefined,
    machineId: string | undefined,
    supplierId: string | undefined,
    planId: string | undefined;
  try {
    const admin = await account('ADMIN'),
      owner = await account('LOCAL_SUPPLIER'),
      other = await account('LOCAL_SUPPLIER'),
      buyer = await account('BUYER');
    const category = await prisma.machineCategory.create({
      data: { name: marker, slug: marker },
    });
    categoryId = category.id;
    const supplier = await prisma.supplier.create({
      data: {
        userId: owner.id,
        companyName: marker,
        type: 'LOCAL',
        description: 'Precision',
        contactName: 'Private contact',
        businessEmail: 'private@example.test',
        businessPhone: '+880123',
        address: 'Private address',
        city: 'Dhaka',
        country: 'Bangladesh',
        documents: [],
        status: 'APPROVED',
        marketplaceVisible: true,
      },
    });
    supplierId = supplier.id;
    const plan = await prisma.subscriptionPlan.create({
      data: {
        name: marker,
        eligibleTypes: ['LOCAL'],
        durationDays: 30,
        price: 1,
        currency: 'USD',
        listingLimit: 10,
        imageLimit: 5,
        specificationLimit: 5,
        canPublishMachinery: true,
        visibility: 'STANDARD',
      },
    });
    planId = plan.id;
    await prisma.supplierSubscription.create({
      data: {
        supplierId: supplier.id,
        planId: plan.id,
        state: 'ACTIVE',
        startsAt: new Date(Date.now() - 10000),
        endsAt: new Date(Date.now() + 3600000),
        planName: marker,
        supplierType: 'LOCAL',
        durationDays: 30,
        price: 1,
        currency: 'USD',
        listingLimit: 10,
        imageLimit: 5,
        specificationLimit: 5,
        canPublishMachinery: true,
        visibility: 'STANDARD',
      },
    });
    const machine = await prisma.machine.create({
      data: {
        name: marker,
        slug: marker,
        description: 'Original',
        manufacturer: 'Original',
        model: 'Original',
        categoryId: category.id,
        supplierId: supplier.id,
        status: 'PUBLISHED',
        images: {
          create: { url: 'https://example.test/fallback.jpg', alt: 'Fallback' },
        },
        specifications: { create: { label: 'Power', value: '5 kW' } },
      },
    });
    machineId = machine.id;
    await t.test(
      'only active admin or entitled owner can upload; no private storage reference enters metadata',
      async () => {
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              undefined,
              'POST',
              form(),
            )
          ).status,
          401,
        );
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              buyer.token,
              'POST',
              form(),
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              other.token,
              'POST',
              form(),
            )
          ).status,
          404,
        );
        const response = await req(
          `/catalogue/machines/${machine.id}/media`,
          owner.token,
          'POST',
          form(),
        );
        assert.equal(response.status, 201);
        assert.equal(response.data.data.type, 'MODEL_3D');
        assert.ok(!('storageKey' in response.data.data));
        assert.ok(!('sha256' in response.data.data));
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              admin.token,
              'POST',
              form('VIEW_360', panoramaFixture()),
            )
          ).status,
          201,
        );
        const publicDetail = await req(`/catalogue/machines/${marker}`); // Existing catalogue route remains unchanged.
        assert.equal(publicDetail.status, 200);
        assert.equal(publicDetail.data.data.media.length, 2);
        assert.equal(publicDetail.data.data.images[0].alt, 'Fallback');
        assert.ok(
          !JSON.stringify(publicDetail.data.data).includes('storageKey'),
        );
        assert.ok(
          !JSON.stringify(publicDetail.data.data).includes(
            'private@example.test',
          ),
        );
      },
    );
    const rows = await prisma.machineMedia.findMany({
        where: { machineId: machine.id },
        orderBy: { position: 'asc' },
      }),
      first = rows[0];
    await t.test(
      'anonymous delivery obeys publication/subscription, previews obey ownership, originals remain intact',
      async () => {
        assert.deepEqual(
          (await req(`/catalogue/media/${first.id}/content`)).buffer,
          glbFixture(),
        );
        assert.equal(
          (await req(`/catalogue/media/${first.id}/preview`, other.token))
            .status,
          404,
        );
        await prisma.machine.update({
          where: { id: machine.id },
          data: { status: 'DRAFT' },
        });
        assert.equal(
          (await req(`/catalogue/media/${first.id}/content`)).status,
          404,
        );
        assert.equal(
          (await req(`/catalogue/media/${first.id}/preview`, admin.token))
            .status,
          200,
        );
        await prisma.machine.update({
          where: { id: machine.id },
          data: { status: 'PUBLISHED' },
        });
        await prisma.supplierSubscription.updateMany({
          where: { supplierId: supplier.id },
          data: { endsAt: new Date(Date.now() - 1) },
        });
        assert.equal(
          (await req(`/catalogue/media/${first.id}/content`)).status,
          404,
        );
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              owner.token,
              'POST',
              form(),
            )
          ).status,
          403,
        );
        await prisma.supplierSubscription.updateMany({
          where: { supplierId: supplier.id },
          data: { endsAt: new Date(Date.now() + 3600000) },
        });
        const current = await prisma.machine.findUniqueOrThrow({
          where: { id: machine.id },
          include: { images: true, specifications: true },
        });
        assert.equal(current.description, 'Original');
        assert.equal(
          current.images[0].url,
          'https://example.test/fallback.jpg',
        );
        assert.equal(current.specifications[0].value, '5 kW');
        const saved = storage.get(first.storageKey)!;
        storage.set(first.storageKey, Buffer.alloc(saved.length));
        assert.equal(
          (await req(`/catalogue/media/${first.id}/content`)).status,
          502,
        );
        storage.set(first.storageKey, saved);
      },
    );
    await t.test(
      'strict upload validation and five-asset cap prevent invalid or unbounded storage',
      async () => {
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              admin.token,
              'POST',
              form('MODEL_3D', Buffer.from('fake')),
            )
          ).status,
          422,
        );
        const bad = form();
        bad.set('storageKey', 'rfq/private');
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              admin.token,
              'POST',
              bad,
            )
          ).status,
          422,
        );
        for (let i = 0; i < 3; i++)
          assert.equal(
            (
              await req(
                `/catalogue/machines/${machine.id}/media`,
                admin.token,
                'POST',
                form(),
              )
            ).status,
            201,
          );
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              admin.token,
              'POST',
              form(),
            )
          ).status,
          422,
        );
        await assert.rejects(
          catalogueAdminService.remove(
            machine.id,
            (
              await prisma.machine.findUniqueOrThrow({
                where: { id: machine.id },
              })
            ).updatedAt.toISOString(),
          ),
          /Remove advanced media/,
        );
      },
    );
    await t.test(
      'storage failure leaves a hidden retryable deletion; deletion frees capacity and storage',
      async () => {
        failedDelete = true;
        assert.equal(
          (await req(`/catalogue/media/${first.id}`, owner.token, 'DELETE'))
            .status,
          502,
        );
        assert.equal(
          (await req(`/catalogue/media/${first.id}/content`)).status,
          404,
        );
        assert.equal(
          (
            await prisma.machineMedia.findUniqueOrThrow({
              where: { id: first.id },
            })
          ).state,
          'DELETING',
        );
        failedDelete = false;
        assert.equal(
          (await req(`/catalogue/media/${first.id}`, owner.token, 'DELETE'))
            .status,
          200,
        );
        assert.ok(!storage.has(first.storageKey));
        failedPut = true;
        const before = await prisma.machineMedia.count({
          where: { machineId: machine.id },
        });
        assert.equal(
          (
            await req(
              `/catalogue/machines/${machine.id}/media`,
              owner.token,
              'POST',
              form(),
            )
          ).status,
          502,
        );
        assert.equal(
          await prisma.machineMedia.count({ where: { machineId: machine.id } }),
          before,
        );
        failedPut = false;
      },
    );
    await t.test(
      'upload reservations stay hidden and interrupted uploads can be removed safely',
      async () => {
        const template = await prisma.machineMedia.findFirstOrThrow({
          where: { machineId: machine.id, state: 'ACTIVE' },
        });
        const pending = await prisma.machineMedia.create({
          data: {
            ...template,
            id: randomUUID(),
            storageKey: `machinery/${machine.id}/${randomUUID()}.glb`,
            state: 'UPLOADING',
            createdAt: new Date(),
          },
        });
        assert.equal(
          (await req(`/catalogue/media/${pending.id}/content`)).status,
          404,
        );
        assert.equal(
          (await req(`/catalogue/media/${pending.id}`, admin.token, 'DELETE'))
            .status,
          409,
        );
        await prisma.machineMedia.update({
          where: { id: pending.id },
          data: { createdAt: new Date(Date.now() - 61000) },
        });
        assert.equal(
          (await req(`/catalogue/media/${pending.id}`, admin.token, 'DELETE'))
            .status,
          200,
        );
        assert.equal(
          await prisma.machineMedia.findUnique({ where: { id: pending.id } }),
          null,
        );
      },
    );
  } finally {
    mock.mock.restore();
    configured.mock.restore();
    if (machineId) {
      await prisma.machineMedia.deleteMany({ where: { machineId } });
      await prisma.machine.deleteMany({ where: { id: machineId } });
    }
    if (categoryId)
      await prisma.machineCategory.delete({ where: { id: categoryId } });
    if (supplierId) {
      await prisma.supplierSubscription.deleteMany({ where: { supplierId } });
      await prisma.supplier.delete({ where: { id: supplierId } });
    }
    if (planId) await prisma.subscriptionPlan.delete({ where: { id: planId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await new Promise<void>((r) => server.close(() => r()));
    await disconnectDatabase();
  }
});
