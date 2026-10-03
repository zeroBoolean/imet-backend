import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
const key = `test-${randomUUID()}`;
let server: Server;
let base: string;
let categoryId: string;
before(async () => {
  const category = await prisma.machineCategory.create({
    data: { name: key, slug: key },
  });
  categoryId = category.id;
  const hidden = await prisma.machineCategory.create({
    data: { name: `${key}-hidden`, slug: `${key}-hidden` },
  });
  for (let index = 0; index < 14; index++)
    await prisma.machine.create({
      data: {
        name: `${key} Machine ${String(index).padStart(2, '0')}`,
        slug: `${key}-${index}`,
        description: 'Precision packaging equipment',
        manufacturer: 'Catalogue Test Manufacturer',
        model: `Model ${index}`,
        categoryId,
        status: 'PUBLISHED',
        images: {
          create: [
            { url: 'https://example.com/second.jpg', alt: 'Side', position: 2 },
            { url: 'https://example.com/first.jpg', alt: 'Front', position: 1 },
          ],
        },
        specifications: {
          create: [
            { label: 'Power', value: '5 kW', position: 2 },
            { label: 'Capacity', value: '100 units/hour', position: 1 },
          ],
        },
      },
    });
  await prisma.machine.create({
    data: {
      name: `${key} Secret draft`,
      slug: `${key}-draft`,
      description: 'Private',
      manufacturer: 'Private',
      model: 'Private',
      categoryId: hidden.id,
    },
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/api/v1/catalogue`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.machine.deleteMany({
    where: { category: { slug: { startsWith: key } } },
  });
  await prisma.machineCategory.deleteMany({
    where: { slug: { startsWith: key } },
  });
  await disconnectDatabase();
});
test('public catalogue filters published records and paginates without leaking private fields', async () => {
  const get = async (page: number) => {
    const response = await fetch(
      `${base}/machines?category=${key}&limit=12&page=${page}`,
    );
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const first = await get(1);
  const second = await get(2);
  assert.deepEqual(first.pagination, {
    page: 1,
    limit: 12,
    total: 14,
    totalPages: 2,
  });
  assert.equal(first.machines.length, 12);
  assert.equal(second.machines.length, 2);
  assert.equal(
    new Set([...first.machines, ...second.machines].map((m) => m.id)).size,
    14,
  );
  assert.equal(first.machines[0].name, `${key} Machine 00`);
  assert.deepEqual(Object.keys(first.machines[0]).sort(), [
    'category',
    'description',
    'id',
    'images',
    'manufacturer',
    'model',
    'name',
    'slug',
  ]);
  assert.deepEqual(first.machines[0].images, [
    { url: 'https://example.com/first.jpg', alt: 'Front' },
  ]);
  const text = JSON.stringify(first);
  for (const field of ['email', 'phone', 'price', 'status', 'categoryId'])
    assert.equal(text.includes(`"${field}"`), false);
});
test('case-insensitive search combines with category and returns accurate empty results', async () => {
  const match = await fetch(`${base}/machines?category=${key}&q=PRECISION`);
  assert.equal((await match.json()).data.pagination.total, 14);
  const empty = await fetch(
    `${base}/machines?category=${key}&q=no-match-${key}`,
  );
  assert.deepEqual((await empty.json()).data.pagination, {
    page: 1,
    limit: 12,
    total: 0,
    totalPages: 0,
  });
  const missingCategory = await fetch(
    `${base}/machines?category=${key}-unknown`,
  );
  assert.equal((await missingCategory.json()).data.machines.length, 0);
  const outside = await fetch(`${base}/machines?category=${key}&page=10`);
  assert.equal((await outside.json()).data.machines.length, 0);
});
test('details expose ordered media and specifications while drafts and unknown machines return 404', async () => {
  const response = await fetch(`${base}/machines/${key}-0`);
  assert.equal(response.status, 200);
  const machine = (await response.json()).data;
  assert.deepEqual(machine.specifications, [
    { label: 'Capacity', value: '100 units/hour' },
    { label: 'Power', value: '5 kW' },
  ]);
  assert.equal(machine.images.length, 2);
  for (const slug of [`${key}-draft`, `${key}-missing`]) {
    const missing = await fetch(`${base}/machines/${slug}`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, 'Machine not found');
  }
  const categories = (await (await fetch(`${base}/categories`)).json()).data;
  assert.ok(categories.some((c) => c.slug === key));
  assert.ok(!categories.some((c) => c.slug === `${key}-hidden`));
});
test('invalid and injected query values are rejected and catalogue has no write endpoints', async () => {
  for (const query of [
    'page=0',
    'page=10001',
    'limit=49',
    'page=1.5',
    'q=' + 'a'.repeat(101),
    'category=bad_slug',
    'q=a&q=b',
    'status=DRAFT',
    'sort=price',
  ]) {
    const response = await fetch(`${base}/machines?${query}`);
    assert.equal(response.status, 422, query);
  }
  const response = await fetch(`${base}/machines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 404);
});
