import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { UserRole } from '../src/generated/enums.js';

test('admin catalogue authorization, validation, publication, atomic edits, conflicts and deletion', async () => {
  const key = `admin-${randomUUID()}`;
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
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
  try {
    const tokens = new Map<string, string>();
    for (const role of Object.values(UserRole)) {
      const user = await prisma.user.create({
        data: {
          email: `${key}-${role.toLowerCase()}@example.test`,
          displayName: 'Catalogue Test',
          password: 'Unusable test hash',
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
      tokens.set(role, signAccessToken(user.id, user.sessions[0].id));
    }
    const token = tokens.get('ADMIN')!;
    const routes: [string, string][] = [
      ['/categories', 'GET'],
      ['/categories', 'POST'],
      [`/categories/${randomUUID()}`, 'PUT'],
      [`/categories/${randomUUID()}`, 'DELETE'],
      ['/machines', 'GET'],
      ['/machines', 'POST'],
      [`/machines/${randomUUID()}`, 'GET'],
      [`/machines/${randomUUID()}`, 'PUT'],
      [`/machines/${randomUUID()}`, 'DELETE'],
    ];
    for (const [path, method] of routes)
      assert.equal(
        (
          await request(
            `/admin/catalogue${path}`,
            method,
            method === 'GET' ? undefined : {},
            undefined,
          )
        ).status,
        401,
      );
    for (const [role, bearer] of tokens)
      if (role !== 'ADMIN')
        for (const [path, method] of routes)
          assert.equal(
            (
              await request(
                `/admin/catalogue${path}`,
                method,
                method === 'GET' ? undefined : {},
                bearer,
              )
            ).status,
            403,
            role + path,
          );
    const created = await request(
      '/admin/catalogue/categories',
      'POST',
      { name: 'Test category', slug: key },
      token,
    );
    assert.equal(created.status, 201);
    const categoryId = created.body.data.id;
    assert.equal(
      (
        await request(
          '/admin/catalogue/categories',
          'POST',
          { name: 'Duplicate', slug: key },
          token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/categories/${categoryId}`,
          'PUT',
          { name: 'Updated category', slug: key },
          token,
        )
      ).status,
      200,
    );
    const data = {
      name: key,
      slug: key,
      description: 'Industrial test machine',
      manufacturer: 'Test Maker',
      model: 'TM-1',
      categoryId,
      images: [{ url: 'https://example.com/a.jpg', alt: 'Front' }],
      specifications: [{ label: 'Power', value: '5 kW' }],
    };
    const draft = await request(
      '/admin/catalogue/machines',
      'POST',
      data,
      token,
    );
    assert.equal(draft.status, 201);
    let machine = draft.body.data;
    assert.equal(machine.status, 'DRAFT');
    assert.equal((await request(`/catalogue/machines/${key}`)).status, 404);
    assert.equal(
      (
        await request(
          `/admin/catalogue/categories/${categoryId}`,
          'DELETE',
          undefined,
          token,
        )
      ).status,
      409,
    );
    assert.equal(
      (await request('/admin/catalogue/machines', 'POST', data, token)).status,
      409,
    );
    for (const body of [
      { ...data, price: 100 },
      { ...data, phone: '123' },
      { ...data, categoryId: 'invalid' },
      { ...data, status: 'APPROVED' },
      { ...data, images: [{ url: 'invalid', alt: 'Front' }] },
      { ...data, images: [{ url: 'http://example.com/a.jpg', alt: 'Front' }] },
      {
        ...data,
        images: [{ url: 'https://user:pass@example.com/a.jpg', alt: 'Front' }],
      },
      { ...data, images: Array(21).fill(data.images[0]) },
      { ...data, specifications: Array(101).fill(data.specifications[0]) },
    ])
      assert.equal(
        (await request('/admin/catalogue/machines', 'POST', body, token))
          .status,
        422,
      );
    assert.equal(
      (
        await request(
          '/admin/catalogue/machines',
          'POST',
          { ...data, slug: `${key}-missing`, categoryId: randomUUID() },
          token,
        )
      ).status,
      409,
    );
    const publish = {
      ...data,
      status: 'PUBLISHED',
      updatedAt: machine.updatedAt,
      images: [
        { url: 'https://example.com/b.jpg', alt: 'Side' },
        { url: 'https://example.com/a.jpg', alt: 'Front' },
      ],
      specifications: [
        { label: 'Capacity', value: '100 units/hour' },
        { label: 'Power', value: '10 kW' },
      ],
    };
    const changed = await request(
      `/admin/catalogue/machines/${machine.id}`,
      'PUT',
      publish,
      token,
    );
    assert.equal(changed.status, 200);
    assert.notEqual(changed.body.data.updatedAt, machine.updatedAt);
    const publicMachine = await request(`/catalogue/machines/${key}`);
    assert.equal(publicMachine.status, 200);
    assert.deepEqual(publicMachine.body.data.images, publish.images);
    assert.deepEqual(
      publicMachine.body.data.specifications,
      publish.specifications,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/machines/${machine.id}`,
          'PUT',
          publish,
          token,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/machines/${machine.id}`,
          'DELETE',
          { updatedAt: machine.updatedAt },
          token,
        )
      ).status,
      409,
    );
    machine = changed.body.data;
    const invalidCategory = await request(
      `/admin/catalogue/machines/${machine.id}`,
      'PUT',
      { ...publish, updatedAt: machine.updatedAt, categoryId: randomUUID() },
      token,
    );
    assert.equal(invalidCategory.status, 409);
    assert.equal(
      (
        await request(
          `/admin/catalogue/machines/${machine.id}`,
          'GET',
          undefined,
          token,
        )
      ).body.data.updatedAt,
      machine.updatedAt,
      'failed transaction must preserve version and child data',
    );
    const page = await request(
      `/admin/catalogue/machines?q=${key}&status=PUBLISHED&limit=1`,
      'GET',
      undefined,
      token,
    );
    assert.equal(page.body.data.pagination.total, 1);
    assert.equal(page.body.data.machines[0].id, machine.id);
    const concurrent = await Promise.all([
      request(
        `/admin/catalogue/machines/${machine.id}`,
        'PUT',
        {
          ...publish,
          name: 'First concurrent edit',
          updatedAt: machine.updatedAt,
        },
        token,
      ),
      request(
        `/admin/catalogue/machines/${machine.id}`,
        'PUT',
        {
          ...publish,
          name: 'Second concurrent edit',
          updatedAt: machine.updatedAt,
        },
        token,
      ),
    ]);
    assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
    machine = concurrent.find((r) => r.status === 200)!.body.data;
    const hidden = await request(
      `/admin/catalogue/machines/${machine.id}`,
      'PUT',
      {
        ...data,
        status: 'DRAFT',
        updatedAt: machine.updatedAt,
        images: [],
        specifications: [],
      },
      token,
    );
    assert.equal(hidden.status, 200);
    machine = hidden.body.data;
    assert.equal(machine.images.length, 0);
    assert.equal(machine.specifications.length, 0);
    assert.equal((await request(`/catalogue/machines/${key}`)).status, 404);
    assert.equal(
      (
        await request(
          `/admin/catalogue/machines/${machine.id}`,
          'DELETE',
          { updatedAt: machine.updatedAt },
          token,
        )
      ).status,
      200,
    );
    assert.equal(
      await prisma.machineImage.count({ where: { machineId: machine.id } }),
      0,
    );
    assert.equal(
      await prisma.machineSpecification.count({
        where: { machineId: machine.id },
      }),
      0,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/machines/${machine.id}`,
          'GET',
          undefined,
          token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/categories/${categoryId}`,
          'DELETE',
          undefined,
          token,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          `/admin/catalogue/categories/${categoryId}`,
          'DELETE',
          undefined,
          token,
        )
      ).status,
      404,
    );
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: `${key}-admin@example.test` },
    });
    await prisma.userRoleAssignment.deleteMany({ where: { userId: admin.id } });
    assert.equal(
      (await request('/admin/catalogue/categories', 'GET', undefined, token))
        .status,
      403,
      'current DB roles must govern access',
    );
  } finally {
    await prisma.machine.deleteMany({ where: { slug: { startsWith: key } } });
    await prisma.machineCategory.deleteMany({
      where: { slug: { startsWith: key } },
    });
    await prisma.user.deleteMany({ where: { email: { startsWith: key } } });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
});
