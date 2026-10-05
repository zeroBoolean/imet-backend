import { catalogueJpegFixture } from './helpers/catalogueImageFixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { bunnyStorage } from '../src/services/bunnyStorage.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { panoramaFixture } from './helpers/mediaFixtures.js';
import {
  catalogueImageService,
  validateCatalogueImage,
} from '../src/modules/catalogue/catalogue.images.service.js';
import type { UserRole } from '../src/generated/enums.js';

test('ordinary image content validation rejects disguised, truncated, oversized and oversized-dimension files', async () => {
  const png = panoramaFixture(128, 128);
  assert.equal((await validateCatalogueImage(png)).fileType, 'image/png');
  assert.equal(
    (await validateCatalogueImage(catalogueJpegFixture())).fileType,
    'image/jpeg',
  );
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('%PDF-1.7'),
    Buffer.alloc(0),
    png.subarray(0, 40),
    Buffer.alloc(10 * 1024 * 1024 + 1),
    panoramaFixture(8193, 1),
  ])
    await assert.rejects(validateCatalogueImage(bytes));
});

test('admin ordinary image upload, ownership, atomic catalogue attachment, delivery gates and durable cleanup', async (t) => {
  const marker = `m3-images-${randomUUID()}`,
    users: string[] = [],
    machineIds: string[] = [];
  let categoryId: string | undefined;
  let server: Server | undefined;
  let mode = 'ok';
  let revokeSession: string | undefined;
  let hideMachine: string | undefined;
  const stored = new Map<string, Buffer>();
  const configured = t.mock.method(
    bunnyStorage,
    'isConfigured',
    () => mode !== 'unconfigured',
  );
  const transport = t.mock.method(
    bunnyStorage,
    'request',
    async (key: string, method: 'GET' | 'PUT' | 'DELETE', body?: Buffer) => {
      assert.match(key, /^catalogue\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg)$/);
      if (mode === 'fail' || (mode === 'delete-fail' && method === 'DELETE'))
        throw new Error('Fixture provider unavailable');
      if (method === 'PUT') {
        if (revokeSession)
          await prisma.userSession.update({
            where: { id: revokeSession },
            data: { revokedAt: new Date() },
          });
        stored.set(key, Buffer.from(body!));
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        stored.delete(key);
        return new Response(null, { status: 200 });
      }
      if (revokeSession)
        await prisma.userSession.update({
          where: { id: revokeSession },
          data: { revokedAt: new Date() },
        });
      if (hideMachine)
        await prisma.machine.update({
          where: { id: hideMachine },
          data: { status: 'DRAFT' },
        });
      return new Response(
        new Uint8Array(
          mode === 'corrupt' ? Buffer.from('changed') : stored.get(key)!,
        ),
      );
    },
  );
  try {
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/v1`;
    const account = async (role: UserRole) => {
      const user = await prisma.user.create({
        data: {
          email: `${marker}-${users.length}@example.test`,
          displayName: 'Catalogue fixture',
          password: 'Unusable fixture',
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
        sessionId: user.sessions[0].id,
        token: signAccessToken(user.id, user.sessions[0].id),
      };
    };
    const admin = await account('ADMIN'),
      other = await account('ADMIN');
    const call = async (
      path: string,
      method = 'GET',
      body?: unknown,
      token?: string,
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const upload = async (
      token?: string,
      bytes = panoramaFixture(128, 128),
      name = 'machine.png',
      extra = false,
    ) => {
      const body = new FormData();
      body.append(
        'file',
        new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
        name,
      );
      if (extra) body.append('ownerId', admin.id);
      const response = await fetch(base + '/admin/catalogue/image-uploads', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body,
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await upload()).status, 401);
    for (const role of [
      'BUYER',
      'LOCAL_SUPPLIER',
      'INTERNATIONAL_MANUFACTURER',
      'INDEPENDENT_SELLER',
      'SALES_PERSON',
    ] as const) {
      const actor = await account(role);
      for (const [path, method] of [
        ['/admin/catalogue/image-uploads/status', 'GET'],
        ['/admin/catalogue/image-uploads/' + randomUUID() + '/preview', 'GET'],
        ['/admin/catalogue/image-uploads/' + randomUUID(), 'DELETE'],
      ] as const)
        assert.equal(
          (await call(path, method, undefined, actor.token)).status,
          403,
        );
      assert.equal((await upload(actor.token)).status, 403);
    }
    assert.equal(
      (await upload(admin.token, Buffer.from('<svg/>'))).status,
      422,
    );
    assert.equal(
      (
        await upload(
          admin.token,
          panoramaFixture(128, 128),
          'machine.png',
          true,
        )
      ).status,
      422,
    );
    assert.equal(
      (await upload(admin.token, Buffer.alloc(10 * 1024 * 1024 + 1))).status,
      422,
    );
    mode = 'unconfigured';
    assert.equal((await upload(admin.token)).status, 503);
    mode = 'ok';
    const first = await upload(admin.token);
    assert.equal(first.status, 201);
    const asset = first.body.data;
    assert.equal(
      (await call('/catalogue/images/' + asset.assetId + '/content')).status,
      404,
    );
    assert.equal(
      (
        await fetch(
          base + '/admin/catalogue/image-uploads/' + asset.assetId + '/preview',
          { headers: { Authorization: `Bearer ${admin.token}` } },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          '/admin/catalogue/image-uploads/' + asset.assetId + '/preview',
          'GET',
          undefined,
          other.token,
        )
      ).status,
      404,
    );
    revokeSession = admin.sessionId;
    assert.equal(
      (
        await call(
          '/admin/catalogue/image-uploads/' + asset.assetId + '/preview',
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      404,
    );
    revokeSession = undefined;
    await prisma.userSession.update({
      where: { id: admin.sessionId },
      data: { revokedAt: null },
    });
    const category = await call(
      '/admin/catalogue/categories',
      'POST',
      { name: marker, slug: marker },
      admin.token,
    );
    assert.equal(category.status, 201);
    categoryId = category.body.data.id;
    const categoryEdit = {
      name: marker + ' edited',
      slug: marker,
      updatedAt: category.body.data.updatedAt,
    };
    const competing = await Promise.all([
      call(
        '/admin/catalogue/categories/' + categoryId,
        'PUT',
        categoryEdit,
        admin.token,
      ),
      call(
        '/admin/catalogue/categories/' + categoryId,
        'PUT',
        categoryEdit,
        admin.token,
      ),
    ]);
    assert.deepEqual(competing.map((value) => value.status).sort(), [200, 409]);
    const data = {
      name: marker,
      slug: marker,
      description: 'Machinery fixture',
      manufacturer: 'Fixture',
      model: 'F-01',
      categoryId,
      status: 'DRAFT',
      images: [{ assetId: asset.assetId, alt: 'Machine front' }],
      specifications: [],
    };
    assert.equal(
      (await call('/admin/catalogue/machines', 'POST', data, other.token))
        .status,
      422,
    );
    const created = await call(
      '/admin/catalogue/machines',
      'POST',
      data,
      admin.token,
    );
    assert.equal(created.status, 201);
    let machine = created.body.data;
    machineIds.push(machine.id);
    assert.equal(machine.images[0].assetId, asset.assetId);
    assert.equal(
      (await call('/catalogue/images/' + asset.assetId + '/content')).status,
      404,
    );
    assert.equal(
      (
        await call(
          '/admin/catalogue/image-uploads/' + asset.assetId,
          'DELETE',
          undefined,
          admin.token,
        )
      ).status,
      409,
    );
    const edit = { ...data, status: 'PUBLISHED', updatedAt: machine.updatedAt };
    const published = await call(
      '/admin/catalogue/machines/' + machine.id,
      'PUT',
      edit,
      admin.token,
    );
    assert.equal(published.status, 200);
    machine = published.body.data;
    const publicResponse = await fetch(
      base + '/catalogue/images/' + asset.assetId + '/content',
    );
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get('content-type'), 'image/png');
    assert.deepEqual(
      Buffer.from(await publicResponse.arrayBuffer()),
      panoramaFixture(128, 128),
    );
    assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
    hideMachine = machine.id;
    assert.equal(
      (await call('/catalogue/images/' + asset.assetId + '/content')).status,
      404,
    );
    hideMachine = undefined;
    await prisma.machine.update({
      where: { id: machine.id },
      data: { status: 'PUBLISHED' },
    });
    machine = await prisma.machine.findUniqueOrThrow({
      where: { id: machine.id },
    });
    mode = 'corrupt';
    assert.equal(
      (await call('/catalogue/images/' + asset.assetId + '/content')).status,
      502,
    );
    mode = 'ok';
    // A stale edit must neither replace rows nor retire an attached file.
    assert.equal(
      (
        await call(
          '/admin/catalogue/machines/' + machine.id,
          'PUT',
          { ...data, images: [], updatedAt: edit.updatedAt },
          admin.token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await prisma.catalogueImageAsset.findUniqueOrThrow({
          where: { id: asset.assetId },
        })
      ).state,
      'ACTIVE',
    );
    const archived = await call(
      '/admin/catalogue/machines/' + machine.id,
      'PUT',
      { ...data, updatedAt: machine.updatedAt },
      admin.token,
    );
    assert.equal(archived.status, 200);
    machine = archived.body.data;
    assert.equal(
      (await call('/catalogue/images/' + asset.assetId + '/content')).status,
      404,
    );
    const removed = await call(
      '/admin/catalogue/machines/' + machine.id,
      'PUT',
      { ...data, images: [], updatedAt: machine.updatedAt },
      admin.token,
    );
    assert.equal(removed.status, 200);
    machine = removed.body.data;
    assert.equal(
      (
        await prisma.catalogueImageAsset.findUniqueOrThrow({
          where: { id: asset.assetId },
        })
      ).state,
      'DELETING',
    );
    mode = 'delete-fail';
    await assert.rejects(catalogueImageService.cleanup([asset.assetId]));
    assert.ok(
      await prisma.catalogueImageAsset.findUnique({
        where: { id: asset.assetId },
      }),
    );
    mode = 'ok';
    await catalogueImageService.cleanup([asset.assetId]);
    assert.equal(
      await prisma.catalogueImageAsset.findUnique({
        where: { id: asset.assetId },
      }),
      null,
    );
    const second = await upload(admin.token);
    assert.equal(second.status, 201);
    const staged = second.body.data.assetId;
    const raced = await Promise.all([
      call(
        '/admin/catalogue/machines',
        'POST',
        {
          ...data,
          slug: marker + '-race-1',
          images: [{ assetId: staged, alt: 'Front' }],
        },
        admin.token,
      ),
      call(
        '/admin/catalogue/machines',
        'POST',
        {
          ...data,
          slug: marker + '-race-2',
          images: [{ assetId: staged, alt: 'Front' }],
        },
        admin.token,
      ),
    ]);
    assert.deepEqual(raced.map((value) => value.status).sort(), [201, 422]);
    for (const result of raced)
      if (result.status === 201) machineIds.push(result.body.data.id);
    mode = 'fail';
    const failed = await upload(admin.token);
    assert.equal(failed.status, 500);
    mode = 'ok';
    await catalogueImageService.cleanup();
    assert.equal(
      await prisma.catalogueImageAsset.count({
        where: { ownerId: admin.id, state: 'DELETING' },
      }),
      0,
    );
    const quotaIds = Array.from({ length: 20 }, () => randomUUID());
    await prisma.catalogueImageAsset.createMany({
      data: quotaIds.map((id) => ({
        id,
        ownerId: admin.id,
        state: 'ACTIVE' as const,
        storageKey: `catalogue/${admin.id}/${id}.png`,
        fileType: 'image/png',
        fileName: 'abandoned.png',
        fileSize: 1,
        sha256: '0'.repeat(64),
        createdAt: new Date(Date.now() - 90000000),
        updatedAt: new Date(Date.now() - 90000000),
      })),
    });
    assert.equal((await upload(admin.token)).status, 422);
    await catalogueImageService.cleanup();
    assert.equal(
      await prisma.catalogueImageAsset.count({
        where: { id: { in: quotaIds } },
      }),
      0,
    );
    const interrupted = randomUUID();
    await prisma.catalogueImageAsset.create({
      data: {
        id: interrupted,
        ownerId: admin.id,
        storageKey: `catalogue/${admin.id}/${interrupted}.png`,
        fileType: 'image/png',
        fileName: 'interrupted.png',
        fileSize: 1,
        sha256: '0'.repeat(64),
        createdAt: new Date(Date.now() - 7200000),
      },
    });
    await catalogueImageService.cleanup();
    assert.equal(
      await prisma.catalogueImageAsset.findUnique({
        where: { id: interrupted },
      }),
      null,
    );
    revokeSession = admin.sessionId;
    assert.equal((await upload(admin.token)).status, 403);
    revokeSession = undefined;
    await prisma.userSession.update({
      where: { id: admin.sessionId },
      data: { revokedAt: null },
    });
    await prisma.userSession.update({
      where: { id: admin.sessionId },
      data: { revokedAt: new Date() },
    });
    assert.equal(
      (
        await call(
          '/admin/catalogue/image-uploads/status',
          'GET',
          undefined,
          admin.token,
        )
      ).status,
      401,
    );
  } finally {
    transport.mock.restore();
    configured.mock.restore();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (categoryId) await prisma.machine.deleteMany({ where: { categoryId } });
    await prisma.catalogueImageAsset.deleteMany({
      where: { ownerId: { in: users } },
    });
    if (categoryId)
      await prisma.machineCategory.delete({ where: { id: categoryId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await disconnectDatabase();
  }
});
