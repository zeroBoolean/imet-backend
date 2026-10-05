import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import app from '../src/app.js';
import { prisma, disconnectDatabase } from '../src/config/database.js';
import { config } from '../src/config/env.js';
import { signAccessToken } from '../src/utils/jwt.js';
import { translationProvider } from '../src/modules/translation/translation.provider.js';
import {
  sourceHash,
  translationService,
} from '../src/modules/translation/translation.service.js';
import type { UserRole } from '../src/generated/client.js';
import type {
  Language,
  TranslationReference,
} from '../src/modules/translation/translation.validation.js';

test('M8 resource-bound public translation, authorization, cache and cost controls', async (t) => {
  const marker = `translation-test-${randomUUID()}`,
    users: string[] = [];
  const day = new Date(new Date().toISOString().slice(0, 10));
  const previousUsage = await prisma.translationUsage.findUnique({
    where: { day },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const req = async (
    path: string,
    token?: string,
    method = 'POST',
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
  const account = async (role: UserRole) => {
    const u = await prisma.user.create({
      data: {
        email: `${marker}-${users.length}@example.test`,
        displayName: marker,
        password: 'unusable fixture',
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
  const text: Record<Language, string> = {
    en: 'CAT 320 excavator\n- Capacity 1.0 m³ / 21.2 ton',
    bn: 'CAT 320 এক্সকাভেটর\n- ধারণক্ষমতা 1.0 m³ / 21.2 ton',
    zh: 'CAT 320 挖掘机\n- 容量 1.0 m³ / 21.2 ton',
  };
  let categoryId: string | undefined,
    machineId: string | undefined,
    supplierId: string | undefined,
    planId: string | undefined,
    rfqId: string | undefined;
  const configured = t.mock.method(
    translationProvider,
    'isConfigured',
    () => true,
  );
  const translate = t.mock.method(
    translationProvider,
    'translate',
    async (_text: string, _source: Language, target: Language) => text[target],
  );
  try {
    const buyer = await account('BUYER'),
      seller = await account('LOCAL_SUPPLIER');
    const category = await prisma.machineCategory.create({
      data: { name: marker, slug: marker },
    });
    categoryId = category.id;
    const supplier = await prisma.supplier.create({
      data: {
        userId: seller.id,
        companyName: marker,
        type: 'LOCAL',
        description: 'Industrial supplier description',
        contactName: 'PRIVATE CONTACT',
        businessEmail: 'private@example.test',
        businessPhone: '+880123456789',
        address: 'PRIVATE ADDRESS',
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
        price: '100',
        currency: 'USD',
        listingLimit: 5,
        imageLimit: 0,
        specificationLimit: 2,
        canPublishMachinery: true,
        visibility: 'STANDARD',
      },
    });
    planId = plan.id;
    await prisma.supplierSubscription.create({
      data: {
        supplierId: supplier.id,
        planId: plan.id,
        planName: plan.name,
        supplierType: 'LOCAL',
        durationDays: 30,
        price: '100',
        currency: 'USD',
        listingLimit: 5,
        imageLimit: 0,
        specificationLimit: 2,
        canPublishMachinery: true,
        visibility: 'STANDARD',
        state: 'ACTIVE',
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    });
    const machine = await prisma.machine.create({
      data: {
        name: 'CAT 320 excavator',
        slug: marker,
        description: text.en,
        manufacturer: 'CAT',
        model: '320',
        categoryId,
        supplierId,
        status: 'PUBLISHED',
        specifications: {
          create: { label: 'Bucket capacity', value: '1.0 m³' },
        },
      },
      include: { specifications: true },
    });
    machineId = machine.id;
    const rfq = await prisma.rfq.create({
      data: {
        rfqNumber: randomUUID(),
        buyerId: buyer.id,
        machineId,
        categoryId,
        title: 'PRIVATE RFQ',
        description: 'PRIVATE REQUIREMENT',
        quantity: '1',
        unit: 'unit',
        deliveryLocation: 'Dhaka',
        deliveryTimeline: '30 days',
        status: 'ACCEPTED',
      },
    });
    rfqId = rfq.id;
    const lead = await prisma.rfqRecipient.create({
      data: {
        rfqId,
        recipientId: seller.id,
        recipientRole: 'SUPPLIER',
        routingReason: 'AUTO',
        leadStatus: 'CLOSED',
      },
    });
    const quote = await prisma.rfqQuote.create({
      data: {
        rfqId,
        recipientId: lead.id,
        unitPrice: '123',
        currency: 'USD',
        moq: '1',
        leadTimeDays: 7,
        validUntil: new Date(Date.now() + 86400000),
        notes: 'PRIVATE QUOTE',
        status: 'ACCEPTED',
      },
    });
    const opportunity = await prisma.salesOpportunity.create({
      data: {
        recipientId: lead.id,
        stage: 'WON',
        internalNotes: 'PRIVATE INTERNAL NOTES',
      },
    });
    const sale = await prisma.saleRecord.create({
      data: {
        opportunityId: opportunity.id,
        recipientId: lead.id,
        acceptedQuoteId: quote.id,
        recordedById: seller.id,
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
    const review = await prisma.review.create({
      data: {
        saleId: sale.id,
        authorId: buyer.id,
        target: 'MACHINERY',
        machineId,
        rating: 5,
        body: 'Reliable machinery',
        status: 'PUBLISHED',
      },
    });
    const reference: TranslationReference = {
      type: 'MACHINERY',
      id: machine.id,
      field: 'DESCRIPTION',
    };
    const read = (resource = reference, targetLanguage: Language = 'bn') =>
      req('/translations/read', undefined, 'POST', {
        resources: [resource],
        targetLanguage,
      });
    const generate = (
      token: string,
      original: string,
      sourceLanguage: Language,
      targetLanguage: Language,
      resource = reference,
      regenerate = false,
    ) =>
      req('/admin/translations/generate', token, 'POST', {
        resource,
        sourceLanguage,
        targetLanguage,
        sourceHash: sourceHash(original),
        regenerate,
      });
    await t.test(
      'all six directions preserve originals and use current source hashes',
      async () => {
        for (const [source, target] of [
          ['en', 'bn'],
          ['en', 'zh'],
          ['bn', 'en'],
          ['bn', 'zh'],
          ['zh', 'en'],
          ['zh', 'bn'],
        ] as [Language, Language][]) {
          const directionAdmin = await account('ADMIN');
          await prisma.machine.update({
            where: { id: machine.id },
            data: { description: text[source] },
          });
          const r = await generate(
            directionAdmin.token,
            text[source],
            source,
            target,
          );
          assert.equal(r.status, 200);
          assert.equal(r.body.data.text, text[target]);
          assert.equal(r.body.data.sourceLanguage, source);
          assert.equal(
            (
              await prisma.machine.findUniqueOrThrow({
                where: { id: machine.id },
              })
            ).description,
            text[source],
          );
          const cached = await read(reference, target);
          assert.equal(cached.body.data[0].text, text[target]);
          const calls = translate.mock.callCount();
          assert.equal(
            (await generate(directionAdmin.token, text[source], source, target))
              .status,
            200,
          );
          assert.equal(translate.mock.callCount(), calls);
        }
      },
    );
    await t.test(
      'same-language, missing key, invalid input and roles are safe',
      async () => {
        const a = await account('ADMIN');
        configured.mock.mockImplementation(() => false);
        for (const l of ['en', 'bn', 'zh'] as const) {
          await prisma.machine.update({
            where: { id: machine.id },
            data: { description: text[l] },
          });
          const calls = translate.mock.callCount();
          const r = await generate(a.token, text[l], l, l);
          assert.equal(r.status, 200);
          assert.equal(r.body.data.text, text[l]);
          assert.equal(translate.mock.callCount(), calls);
        }
        assert.equal(
          (await generate(a.token, text.zh, 'zh', 'en', reference, true))
            .status,
          503,
        );
        assert.equal(
          (await generate(buyer.token, text.zh, 'zh', 'en')).status,
          403,
        );
        assert.equal(
          (await generate(seller.token, text.zh, 'zh', 'en')).status,
          403,
        );
        assert.equal((await generate('', text.zh, 'zh', 'en')).status, 401);
        await prisma.user.update({
          where: { id: a.id },
          data: { status: 'SUSPENDED' },
        });
        assert.equal(
          (await generate(a.token, text.zh, 'zh', 'en')).status,
          403,
        );
        await prisma.user.update({
          where: { id: a.id },
          data: { status: 'ACTIVE' },
        });
        assert.equal(
          (await req('/admin/translations/resources', buyer.token, 'GET'))
            .status,
          403,
        );
        const invalid = await req('/translations/read', undefined, 'POST', {
          resources: [{ ...reference, field: 'VALUE' }],
          targetLanguage: 'bn',
        });
        assert.equal(invalid.status, 422);
        assert.equal(
          (
            await req('/translations/read', undefined, 'POST', {
              resources: [reference],
              targetLanguage: 'fr',
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await req('/translations/read', undefined, 'POST', {
              resources: Array(41).fill(reference),
              targetLanguage: 'bn',
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await req('/translations/read', undefined, 'POST', {
              resources: [{ ...reference, type: 'RFQ' }],
              targetLanguage: 'bn',
            })
          ).status,
          422,
        );
        assert.equal(
          (
            await req('/admin/translations/generate', a.token, 'POST', {
              resource: reference,
              sourceLanguage: 'zh',
              targetLanguage: 'en',
              sourceHash: sourceHash(text.zh),
              text: 'forged content',
            })
          ).status,
          422,
        );
        configured.mock.mockImplementation(() => true);
      },
    );
    await t.test(
      'structured fields, publication gates and safe public projections',
      async () => {
        const a = await account('ADMIN');
        for (const [r, original] of [
          [
            {
              type: 'SPECIFICATION',
              id: machine.specifications[0].id,
              field: 'LABEL',
            },
            'Bucket capacity',
          ],
          [
            { type: 'SUPPLIER', id: supplier.id, field: 'DESCRIPTION' },
            supplier.description,
          ],
          [{ type: 'REVIEW', id: review.id, field: 'BODY' }, review.body],
        ] as [TranslationReference, string][]) {
          assert.equal(
            (await generate(a.token, original, 'en', 'bn', r)).status,
            200,
          );
          const publicResponse = await read(r);
          assert.equal(publicResponse.status, 200);
          assert.deepEqual(Object.keys(publicResponse.body.data[0]).sort(), [
            'resource',
            'sourceLanguage',
            'sourceText',
            'status',
            'targetLanguage',
            'text',
          ]);
          for (const value of [
            'PRIVATE CONTACT',
            'private@example.test',
            'PRIVATE ADDRESS',
            'PRIVATE RFQ',
            'PRIVATE QUOTE',
            'PRIVATE INTERNAL NOTES',
            sale.id,
          ])
            assert(!JSON.stringify(publicResponse.body).includes(value));
        }
        assert.equal(
          (
            await prisma.machineSpecification.findUniqueOrThrow({
              where: { id: machine.specifications[0].id },
            })
          ).value,
          '1.0 m³',
        );
        await prisma.review.update({
          where: { id: review.id },
          data: { status: 'HIDDEN' },
        });
        assert.equal(
          (await read({ type: 'REVIEW', id: review.id, field: 'BODY' })).status,
          404,
        );
        await prisma.review.update({
          where: { id: review.id },
          data: { status: 'PUBLISHED' },
        });
        await prisma.machine.update({
          where: { id: machine.id },
          data: { status: 'DRAFT' },
        });
        assert.equal((await read()).status, 404);
        assert.equal(
          (await generate(a.token, text.zh, 'zh', 'en')).status,
          404,
        );
        await prisma.machine.update({
          where: { id: machine.id },
          data: { status: 'PUBLISHED' },
        });
        await prisma.supplierSubscription.updateMany({
          where: { supplierId: supplier.id },
          data: { endsAt: new Date(Date.now() - 1000) },
        });
        assert.equal(
          (
            await read({
              type: 'SUPPLIER',
              id: supplier.id,
              field: 'DESCRIPTION',
            })
          ).status,
          404,
        );
        assert.equal((await read()).status, 404);
        await prisma.supplierSubscription.updateMany({
          where: { supplierId: supplier.id },
          data: { endsAt: new Date(Date.now() + 86400000) },
        });
        const detail = await req(
          `/admin/translations/resources/MACHINERY/${machine.id}`,
          a.token,
          'GET',
        );
        assert.equal(detail.status, 200);
        assert.equal(detail.body.data.fields.length, 3);
        assert.equal(
          detail.body.data.fields[2].resource.id,
          machine.specifications[0].id,
        );
        for (const type of ['MACHINERY', 'SUPPLIER', 'REVIEW']) {
          const list = await req(
            '/admin/translations/resources?' +
              new URLSearchParams({
                type,
                q:
                  type === 'REVIEW'
                    ? 'Reliable'
                    : type === 'MACHINERY'
                      ? 'CAT'
                      : marker,
              }),
            a.token,
            'GET',
          );
          assert.equal(list.status, 200);
          assert(list.body.data.resources.length);
        }
      },
    );
    await t.test(
      'stale/failed/missing fallback, size limits and provider error privacy',
      async () => {
        const a = await account('ADMIN');
        await prisma.machine.update({
          where: { id: machine.id },
          data: { description: 'New original' },
        });
        assert.equal((await read()).body.data[0].status, 'STALE');
        assert.equal((await read()).body.data[0].text, null);
        assert.equal(
          (await generate(a.token, 'Old original', 'en', 'bn')).status,
          409,
        );
        translate.mock.mockImplementation(async () => {
          throw new Error('SECRET PROVIDER KEY / private error');
        });
        const failed = await generate(a.token, 'New original', 'en', 'bn');
        assert.equal(failed.status, 502);
        assert(!JSON.stringify(failed.body).includes('SECRET'));
        assert.equal((await read()).body.data[0].status, 'FAILED');
        const name: TranslationReference = {
          type: 'MACHINERY',
          id: machine.id,
          field: 'NAME',
        };
        assert.equal((await read(name)).body.data[0].status, 'MISSING');
        for (const original of [
          '',
          ' '.repeat(10),
          'x'.repeat(config.AI_TRANSLATION_MAX_CHARACTERS + 1),
        ]) {
          await prisma.machine.update({
            where: { id: machine.id },
            data: { description: original },
          });
          assert.equal(
            (await generate(a.token, original, 'en', 'bn')).status,
            422,
          );
          assert.equal(
            (
              await prisma.machine.findUniqueOrThrow({
                where: { id: machine.id },
              })
            ).description,
            original,
          );
        }
        await prisma.machine.update({
          where: { id: machine.id },
          data: { description: 'New original' },
        });
        translate.mock.mockImplementation(async () => 'নতুন মূল লেখা');
        assert.equal(
          (await generate(a.token, 'New original', 'en', 'bn')).status,
          200,
        );
      },
    );
    await t.test(
      'duplicate claims, source edits during calls and expired processing retries',
      async () => {
        const a = await account('ADMIN');
        let release!: () => void, started!: () => void;
        const start = new Promise<void>((r) => {
          started = r;
        });
        const wait = new Promise<void>((r) => {
          release = r;
        });
        const calls = translate.mock.callCount();
        translate.mock.mockImplementation(async () => {
          started();
          await wait;
          return 'নতুন মূল লেখা';
        });
        const first = generate(
          a.token,
          'New original',
          'en',
          'bn',
          reference,
          true,
        );
        await start;
        const second = await generate(
          a.token,
          'New original',
          'en',
          'bn',
          reference,
          true,
        );
        assert.equal(second.status, 202);
        assert.equal((await read()).body.data[0].text, null);
        release();
        assert.equal((await first).status, 200);
        assert.equal(translate.mock.callCount(), calls + 1);
        let changeRelease!: () => void, changeStarted!: () => void;
        const begun = new Promise<void>((r) => {
          changeStarted = r;
        });
        const pending = new Promise<void>((r) => {
          changeRelease = r;
        });
        translate.mock.mockImplementation(async () => {
          changeStarted();
          await pending;
          return 'পুরোনো ফলাফল';
        });
        const changing = generate(
          a.token,
          'New original',
          'en',
          'bn',
          reference,
          true,
        );
        await begun;
        await prisma.machine.update({
          where: { id: machine.id },
          data: { description: 'Changed while translating' },
        });
        assert.equal(
          (await generate(a.token, 'Changed while translating', 'en', 'bn'))
            .status,
          409,
        );
        changeRelease();
        assert.equal((await changing).status, 409);
        assert.equal((await read()).body.data[0].text, null);
        await prisma.contentTranslation.updateMany({
          where: {
            machineId: machine.id,
            field: 'DESCRIPTION',
            targetLanguage: 'bn',
          },
          data: {
            sourceHash: sourceHash('Changed while translating'),
            status: 'PROCESSING',
            translatedText: null,
            claimId: randomUUID(),
            processingUntil: new Date(Date.now() - 1000),
          },
        });
        translate.mock.mockImplementation(async () => 'পরিবর্তিত লেখা');
        assert.equal(
          (await generate(a.token, 'Changed while translating', 'en', 'bn'))
            .status,
          200,
        );
      },
    );
    await t.test(
      'durable global allowance and per-admin rate limit',
      async () => {
        const a = await account('ADMIN');
        const usage = await prisma.translationUsage.findUniqueOrThrow({
          where: { day },
        });
        await prisma.translationUsage.update({
          where: { day },
          data: { requests: config.AI_TRANSLATION_DAILY_LIMIT },
        });
        try {
          assert.equal(
            (
              await generate(
                a.token,
                'Changed while translating',
                'en',
                'zh',
                reference,
                true,
              )
            ).status,
            429,
          );
        } finally {
          await prisma.translationUsage.update({
            where: { day },
            data: { requests: usage.requests },
          });
        }
        const limited = await account('ADMIN');
        for (let i = 0; i < 10; i++)
          assert.equal(
            (
              await generate(
                limited.token,
                'Changed while translating',
                'en',
                'en',
              )
            ).status,
            200,
          );
        assert.equal(
          (
            await generate(
              limited.token,
              'Changed while translating',
              'en',
              'en',
            )
          ).status,
          429,
        );
        assert.equal(
          (
            await prisma.machine.findUniqueOrThrow({
              where: { id: machine.id },
            })
          ).description,
          'Changed while translating',
        );
        // Cache and same-language operations did not increment the durable allowance.
        assert.equal(
          (await prisma.translationUsage.findUniqueOrThrow({ where: { day } }))
            .requests,
          usage.requests,
        );
        assert.equal(
          (await translationService.read([reference], 'bn'))[0].text,
          'পরিবর্তিত লেখা',
        );
      },
    );
  } finally {
    configured.mock.restore();
    translate.mock.restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousUsage)
      await prisma.translationUsage.upsert({
        where: { day },
        create: previousUsage,
        update: { requests: previousUsage.requests },
      });
    else await prisma.translationUsage.deleteMany({ where: { day } });
    await prisma.review.deleteMany({ where: { authorId: { in: users } } });
    if (rfqId) {
      await prisma.salesEvent.deleteMany({
        where: { opportunity: { recipient: { rfqId } } },
      });
      await prisma.saleRecord.deleteMany({
        where: { opportunity: { recipient: { rfqId } } },
      });
      await prisma.salesOpportunity.deleteMany({
        where: { recipient: { rfqId } },
      });
      await prisma.rfqQuote.deleteMany({ where: { rfqId } });
      await prisma.rfqRecipient.deleteMany({ where: { rfqId } });
      await prisma.rfq.delete({ where: { id: rfqId } });
    }
    if (machineId) await prisma.machine.delete({ where: { id: machineId } });
    if (supplierId) {
      await prisma.supplierSubscription.deleteMany({ where: { supplierId } });
      await prisma.supplier.delete({ where: { id: supplierId } });
    }
    if (planId) await prisma.subscriptionPlan.delete({ where: { id: planId } });
    if (categoryId)
      await prisma.machineCategory.delete({ where: { id: categoryId } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await disconnectDatabase();
  }
});
