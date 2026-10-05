import { recordAudit } from '../audit/audit.record.js';
import { prisma } from '../../config/database.js';
import type { Prisma, ReviewTarget } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation } from '../../utils/databaseMutation.js';
import { lockRfq, checkVersion, touch, type Actor } from '../rfq/rfq.access.js';
import {
  publicMachineWhere,
  publicSupplierWhere,
} from '../subscription/subscription.entitlements.js';
import type { ReviewQuery, PublicReviewQuery } from './review.validation.js';
const publicSelect = {
  id: true,
  target: true,
  rating: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { displayName: true } },
  machine: { select: { id: true, name: true, slug: true } },
  supplier: { select: { id: true, companyName: true } },
} satisfies Prisma.ReviewSelect;
const privateInclude = {
  author: { select: { displayName: true } },
  machine: { select: { id: true, name: true, slug: true } },
  supplier: { select: { id: true, companyName: true } },
  sale: {
    select: {
      id: true,
      opportunity: {
        select: {
          recipient: {
            select: { rfq: { select: { title: true, rfqNumber: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.ReviewInclude;
const pagination = (q: { page: number; limit: number }, total: number) => ({
  ...q,
  total,
  totalPages: Math.ceil(total / q.limit),
});
const visible = (now = new Date()): Prisma.ReviewWhereInput => ({
  status: 'PUBLISHED',
  OR: [
    { target: 'MACHINERY', machine: { is: publicMachineWhere(now) } },
    { target: 'SUPPLIER', supplier: { is: publicSupplierWhere(now) } },
  ],
});
async function sale(
  tx: Prisma.TransactionClient,
  id: string,
  a: Actor,
  lock = false,
) {
  if (lock) {
    const initial = await tx.saleRecord.findUnique({
      where: { id },
      select: {
        opportunity: { select: { recipient: { select: { rfqId: true } } } },
      },
    });
    if (!initial) throw new AppError('Sale record not found', 404);
    await lockRfq(tx, initial.opportunity.recipient.rfqId);
  }
  const s = await tx.saleRecord.findUnique({
    where: { id },
    include: {
      opportunity: {
        include: {
          recipient: {
            include: {
              rfq: {
                select: {
                  buyerId: true,
                  machine: { select: { id: true, name: true, slug: true } },
                },
              },
              recipient: {
                select: {
                  supplier: { select: { id: true, companyName: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!s || s.opportunity.recipient.rfq.buyerId !== a.id)
    throw new AppError('Sale record not found', 404);
  return s;
}
async function own(tx: Prisma.TransactionClient, id: string, a: Actor) {
  const initial = await tx.review.findUnique({
    where: { id },
    select: { saleId: true, authorId: true },
  });
  if (!initial || initial.authorId !== a.id)
    throw new AppError('Review not found', 404);
  await sale(tx, initial.saleId, a, true);
  await tx.$queryRaw`SELECT id FROM reviews WHERE id=${id} FOR UPDATE`;
  return tx.review.findUniqueOrThrow({ where: { id } });
}
export const reviewService = {
  eligibility: (a: Actor, id: string) =>
    prisma.$transaction(async (tx) => {
      const s = await sale(tx, id, a);
      const reviews = await tx.review.findMany({
        where: { saleId: id, authorId: a.id },
        include: privateInclude,
      });
      const r = s.opportunity.recipient;
      return {
        saleId: id,
        eligible: s.status === 'COMPLETED',
        reason:
          s.status === 'COMPLETED'
            ? null
            : 'Reviews become available after this sale is completed.',
        targets: [
          ...(r.recipient.supplier
            ? [
                {
                  target: 'SUPPLIER' as const,
                  id: r.recipient.supplier.id,
                  name: r.recipient.supplier.companyName,
                },
              ]
            : []),
          ...(r.rfq.machine
            ? [
                {
                  target: 'MACHINERY' as const,
                  id: r.rfq.machine.id,
                  name: r.rfq.machine.name,
                },
              ]
            : []),
        ],
        reviews,
      };
    }),
  create: (
    a: Actor,
    data: {
      saleId: string;
      target: ReviewTarget;
      rating: number;
      body: string;
    },
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const s = await sale(tx, data.saleId, a, true);
        if (s.status !== 'COMPLETED')
          throw new AppError('A completed sale is required to review', 403);
        const r = s.opportunity.recipient;
        const targetId =
          data.target === 'MACHINERY'
            ? r.rfq.machine?.id
            : r.recipient.supplier?.id;
        if (!targetId)
          throw new AppError('This sale has no eligible review target', 422);
        return tx.review.create({
          data: {
            ...data,
            authorId: a.id,
            ...(data.target === 'MACHINERY'
              ? { machineId: targetId }
              : { supplierId: targetId }),
          },
          include: privateInclude,
        });
      }),
    ),
  update: (
    a: Actor,
    id: string,
    data: { updatedAt: string; rating: number; body: string },
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const old = await own(tx, id, a);
        checkVersion(old.updatedAt, data.updatedAt);
        // Editing (including a withdrawn review) is a resubmission, never a second review.
        return tx.review.update({
          where: { id },
          data: {
            rating: data.rating,
            body: data.body,
            status: 'PENDING',
            moderationNote: null,
            moderatedById: null,
            moderatedAt: null,
            updatedAt: touch(old.updatedAt),
          },
          include: privateInclude,
        });
      }),
    ),
  withdraw: (a: Actor, id: string, version: string) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const old = await own(tx, id, a);
        checkVersion(old.updatedAt, version);
        if (old.status === 'WITHDRAWN')
          throw new AppError('Review is already withdrawn', 409);
        return tx.review.update({
          where: { id },
          data: { status: 'WITHDRAWN', updatedAt: touch(old.updatedAt) },
          include: privateInclude,
        });
      }),
    ),
  async list(a: Actor, q: ReviewQuery, admin = false) {
    const where: Prisma.ReviewWhereInput = {
      ...(admin ? {} : { authorId: a.id }),
      ...(q.status ? { status: q.status } : {}),
      ...(q.target ? { target: q.target } : {}),
      ...(q.q
        ? {
            OR: [
              { body: { contains: q.q, mode: 'insensitive' } },
              { machine: { name: { contains: q.q, mode: 'insensitive' } } },
              {
                supplier: {
                  companyName: { contains: q.q, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const [total, reviews] = await prisma.$transaction([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        include: privateInclude,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    return {
      reviews,
      pagination: pagination({ page: q.page, limit: q.limit }, total),
    };
  },
  moderate: (
    a: Actor,
    id: string,
    data: {
      updatedAt: string;
      status: 'PUBLISHED' | 'REJECTED' | 'HIDDEN';
      note: string;
    },
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM reviews WHERE id=${id} FOR UPDATE`;
        const old = await tx.review.findUnique({ where: { id } });
        if (!old) throw new AppError('Review not found', 404);
        checkVersion(old.updatedAt, data.updatedAt);
        if (old.status === 'WITHDRAWN')
          throw new AppError(
            'A withdrawn review cannot be moderated; its buyer must resubmit it',
            409,
          );
        if (old.status === data.status)
          throw new AppError('Review already has this status', 409);
        const result = await tx.review.update({
          where: { id },
          data: {
            status: data.status,
            moderationNote: data.note || null,
            moderatedById: a.id,
            moderatedAt: new Date(),
            updatedAt: touch(old.updatedAt),
          },
          include: privateInclude,
        });
        await recordAudit(
          tx,
          a.id,
          'REVIEW_MODERATED',
          'REVIEW',
          id,
          ['status'],
          old,
          result,
        );
        return result;
      }),
    ),
  publicList: (q: PublicReviewQuery) =>
    prisma.$transaction(
      async (tx) => {
        const targetExists =
          q.target === 'MACHINERY'
            ? await tx.machine.findFirst({
                where: { id: q.targetId, ...publicMachineWhere() },
                select: { id: true },
              })
            : await tx.supplier.findFirst({
                where: { id: q.targetId, ...publicSupplierWhere() },
                select: { id: true },
              });
        if (!targetExists) throw new AppError('Review target not found', 404);
        const where: Prisma.ReviewWhereInput = {
          status: 'PUBLISHED',
          ...(q.target === 'MACHINERY'
            ? { machineId: q.targetId }
            : { supplierId: q.targetId }),
        };
        const [stats, groups, reviews] = await Promise.all([
          tx.review.aggregate({ where, _avg: { rating: true }, _count: true }),
          tx.review.groupBy({
            by: ['rating'],
            where,
            _count: true,
            orderBy: { rating: 'desc' },
          }),
          tx.review.findMany({
            where,
            select: publicSelect,
            skip: (q.page - 1) * q.limit,
            take: q.limit,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        ]);
        return {
          reviews,
          summary: {
            average: stats._avg.rating,
            count: stats._count,
            distribution: Object.fromEntries(
              [1, 2, 3, 4, 5].map((r) => [
                r,
                groups.find((g) => g.rating === r)?._count ?? 0,
              ]),
            ),
          },
          pagination: pagination(
            { page: q.page, limit: q.limit },
            stats._count,
          ),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    ),
  highlights: (limit: number) =>
    prisma.review.findMany({
      where: visible(),
      select: publicSelect,
      take: limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
};
