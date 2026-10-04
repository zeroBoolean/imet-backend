import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import type { Prisma, ContentTranslation } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  publicMachineWhere,
  publicSupplierWhere,
} from '../subscription/subscription.entitlements.js';
import { translationProvider } from './translation.provider.js';
import type {
  TranslationReference,
  Language,
  GenerationInput,
  ResourceQuery,
} from './translation.validation.js';
export const sourceHash = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const key = (r: TranslationReference, language: Language) =>
  `${r.type}:${r.id}:${r.field}:${language}`;
async function source(
  tx: Prisma.TransactionClient,
  r: TranslationReference,
): Promise<string> {
  if (r.type === 'MACHINERY') {
    const m = await tx.machine.findFirst({
      where: { id: r.id, ...publicMachineWhere() },
      select: { name: true, description: true },
    });
    if (m) return r.field === 'NAME' ? m.name : m.description;
  } else if (r.type === 'SPECIFICATION') {
    const s = await tx.machineSpecification.findFirst({
      where: { id: r.id, machine: { is: publicMachineWhere() } },
      select: { label: true },
    });
    if (s) return s.label;
  } else if (r.type === 'SUPPLIER') {
    const s = await tx.supplier.findFirst({
      where: { id: r.id, ...publicSupplierWhere() },
      select: { description: true },
    });
    if (s) return s.description;
  } else {
    const review = await tx.review.findFirst({
      where: {
        id: r.id,
        status: 'PUBLISHED',
        OR: [
          { target: 'MACHINERY', machine: { is: publicMachineWhere() } },
          { target: 'SUPPLIER', supplier: { is: publicSupplierWhere() } },
        ],
      },
      select: { body: true },
    });
    if (review) return review.body;
  }
  throw new AppError('Public translation resource not found', 404);
}
function projection(
  r: TranslationReference,
  original: string,
  target: Language,
  row?: ContentTranslation | null,
) {
  const current = row?.sourceHash === sourceHash(original);
  return {
    resource: r,
    sourceText: original,
    targetLanguage: target,
    sourceLanguage: current ? row.sourceLanguage : null,
    status: !row ? 'MISSING' : !current ? 'STALE' : row.status,
    text: current && row.status === 'COMPLETED' ? row.translatedText : null,
  };
}
const foreignKey = (r: TranslationReference) => ({
  machineId: r.type === 'MACHINERY' ? r.id : null,
  specificationId: r.type === 'SPECIFICATION' ? r.id : null,
  supplierId: r.type === 'SUPPLIER' ? r.id : null,
  reviewId: r.type === 'REVIEW' ? r.id : null,
});
export const translationService = {
  read: (resources: TranslationReference[], targetLanguage: Language) =>
    prisma.$transaction(
      async (tx) => {
        const unique = [
          ...new Map(
            resources.map((r) => [key(r, targetLanguage), r]),
          ).values(),
        ];
        const rows = await tx.contentTranslation.findMany({
          where: {
            cacheKey: { in: unique.map((r) => key(r, targetLanguage)) },
          },
        });
        return Promise.all(
          unique.map(async (r) =>
            projection(
              r,
              await source(tx, r),
              targetLanguage,
              rows.find((c) => c.cacheKey === key(r, targetLanguage)),
            ),
          ),
        );
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  async resources(q: ResourceQuery) {
    const paging = { skip: (q.page - 1) * q.limit, take: q.limit };
    return prisma.$transaction(
      async (tx) => {
        let total: number,
          resources: {
            type: ResourceQuery['type'];
            id: string;
            title: string;
          }[];
        if (q.type === 'MACHINERY') {
          const where = {
            ...publicMachineWhere(),
            ...(q.q
              ? { name: { contains: q.q, mode: 'insensitive' as const } }
              : {}),
          };
          total = await tx.machine.count({ where });
          resources = (
            await tx.machine.findMany({
              where,
              ...paging,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              select: { id: true, name: true },
            })
          ).map((m) => ({ type: q.type, id: m.id, title: m.name }));
        } else if (q.type === 'SUPPLIER') {
          const where = {
            ...publicSupplierWhere(),
            ...(q.q
              ? { companyName: { contains: q.q, mode: 'insensitive' as const } }
              : {}),
          };
          total = await tx.supplier.count({ where });
          resources = (
            await tx.supplier.findMany({
              where,
              ...paging,
              orderBy: [{ companyName: 'asc' }, { id: 'asc' }],
              select: { id: true, companyName: true },
            })
          ).map((s) => ({ type: q.type, id: s.id, title: s.companyName }));
        } else {
          const where: Prisma.ReviewWhereInput = {
            status: 'PUBLISHED',
            OR: [
              { target: 'MACHINERY', machine: { is: publicMachineWhere() } },
              { target: 'SUPPLIER', supplier: { is: publicSupplierWhere() } },
            ],
            ...(q.q ? { body: { contains: q.q, mode: 'insensitive' } } : {}),
          };
          total = await tx.review.count({ where });
          resources = (
            await tx.review.findMany({
              where,
              ...paging,
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { id: true, body: true },
            })
          ).map((r) => ({
            type: q.type,
            id: r.id,
            title: r.body.slice(0, 160),
          }));
        }
        return {
          resources,
          pagination: {
            page: q.page,
            limit: q.limit,
            total,
            totalPages: Math.ceil(total / q.limit),
          },
          providerConfigured: translationProvider.isConfigured(),
          maxCharacters: config.AI_TRANSLATION_MAX_CHARACTERS,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  },
  detail: (type: ResourceQuery['type'], id: string) =>
    prisma.$transaction(
      async (tx) => {
        const references: TranslationReference[] =
          type === 'MACHINERY'
            ? [
                { type, id, field: 'NAME' },
                { type, id, field: 'DESCRIPTION' },
              ]
            : [
                {
                  type,
                  id,
                  field: type === 'SUPPLIER' ? 'DESCRIPTION' : 'BODY',
                },
              ];
        // Validate the parent before inspecting its specification labels.
        await source(tx, references[0]);
        if (type === 'MACHINERY') {
          const specs = await tx.machineSpecification.findMany({
            where: { machineId: id },
            select: { id: true },
            orderBy: [{ position: 'asc' }, { id: 'asc' }],
          });
          references.push(
            ...specs.map((s) => ({
              type: 'SPECIFICATION' as const,
              id: s.id,
              field: 'LABEL' as const,
            })),
          );
        }
        const fields = [];
        for (const r of references) {
          const original = await source(tx, r);
          const rows = await tx.contentTranslation.findMany({
            where: {
              cacheKey: {
                in: (['en', 'bn', 'zh'] as const).map((l) => key(r, l)),
              },
            },
          });
          fields.push({
            resource: r,
            original,
            sourceHash: sourceHash(original),
            translations: (['en', 'bn', 'zh'] as const).map((l) =>
              projection(
                r,
                original,
                l,
                rows.find((row) => row.targetLanguage === l),
              ),
            ),
          });
        }
        return {
          fields,
          providerConfigured: translationProvider.isConfigured(),
          maxCharacters: config.AI_TRANSLATION_MAX_CHARACTERS,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  async generate(data: GenerationInput) {
    const cacheKey = key(data.resource, data.targetLanguage),
      claimId = randomUUID();
    const claim = await prisma.$transaction(async (tx) => {
      // Only the short DB claim/allowance transaction is serialized; never hold a lock across AI calls.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('imet-translation-claims'))::text`;
      const original = await source(tx, data.resource);
      const hash = sourceHash(original);
      if (hash !== data.sourceHash)
        throw new AppError(
          'Source content changed. Reload before translating.',
          409,
        );
      if (!original.trim())
        throw new AppError('Empty content cannot be translated', 422);
      if (original.length > config.AI_TRANSLATION_MAX_CHARACTERS)
        throw new AppError(
          `This field exceeds the ${config.AI_TRANSLATION_MAX_CHARACTERS}-character translation limit. Original content remains available.`,
          422,
        );
      const old = await tx.contentTranslation.findUnique({
        where: { cacheKey },
      });
      if (
        old?.status === 'PROCESSING' &&
        old.processingUntil &&
        old.processingUntil > new Date()
      ) {
        if (
          old.sourceHash !== hash ||
          old.sourceLanguage !== data.sourceLanguage
        )
          throw new AppError(
            'A previous translation is still processing. Reload its status shortly.',
            409,
          );
        return { original, hash, row: old, call: false };
      }
      if (
        old?.status === 'COMPLETED' &&
        old.sourceHash === hash &&
        old.sourceLanguage === data.sourceLanguage &&
        !data.regenerate
      )
        return { original, hash, row: old, call: false };
      const same = data.sourceLanguage === data.targetLanguage;
      if (!same) {
        if (!translationProvider.isConfigured())
          throw new AppError(
            'AI translation is not configured. Ask an administrator to configure the server key.',
            503,
          );
        const day = new Date(new Date().toISOString().slice(0, 10));
        const usage = await tx.translationUsage.findUnique({ where: { day } });
        if ((usage?.requests ?? 0) >= config.AI_TRANSLATION_DAILY_LIMIT)
          throw new AppError(
            'The daily AI translation allowance has been reached. Try again after the daily allowance resets.',
            429,
          );
        await tx.translationUsage.upsert({
          where: { day },
          create: { day, requests: 1 },
          update: { requests: { increment: 1 } },
        });
      }
      const values = {
        ...foreignKey(data.resource),
        field: data.resource.field,
        sourceLanguage: data.sourceLanguage,
        targetLanguage: data.targetLanguage,
        sourceHash: hash,
        translatedText: same ? original : null,
        status: same ? ('COMPLETED' as const) : ('PROCESSING' as const),
        claimId: same ? null : claimId,
        processingUntil: same
          ? null
          : new Date(Date.now() + config.AI_TRANSLATION_TIMEOUT_MS + 15000),
      };
      const row = await tx.contentTranslation.upsert({
        where: { cacheKey },
        create: { cacheKey, ...values },
        update: values,
      });
      return { original, hash, row, call: !same };
    });
    if (!claim.call)
      return projection(
        data.resource,
        claim.original,
        data.targetLanguage,
        claim.row,
      );
    try {
      const translated = await translationProvider.translate(
        claim.original,
        data.sourceLanguage,
        data.targetLanguage,
      );
      return await prisma.$transaction(async (tx) => {
        const current = await source(tx, data.resource);
        if (sourceHash(current) !== claim.hash)
          throw new AppError(
            'Source content changed during translation. Reload and retry.',
            409,
          );
        const saved = await tx.contentTranslation.updateMany({
          where: {
            cacheKey,
            claimId,
            sourceHash: claim.hash,
            status: 'PROCESSING',
          },
          data: {
            status: 'COMPLETED',
            translatedText: translated,
            claimId: null,
            processingUntil: null,
          },
        });
        if (!saved.count)
          throw new AppError(
            'Translation request changed. Reload its status.',
            409,
          );
        return projection(
          data.resource,
          current,
          data.targetLanguage,
          await tx.contentTranslation.findUniqueOrThrow({
            where: { cacheKey },
          }),
        );
      });
    } catch (e) {
      await prisma.contentTranslation.updateMany({
        where: { cacheKey, claimId },
        data: {
          status: 'FAILED',
          translatedText: null,
          claimId: null,
          processingUntil: null,
        },
      });
      if (e instanceof AppError) throw e;
      throw new AppError(
        'Translation could not be completed. Original content remains available.',
        502,
      );
    }
  },
};
