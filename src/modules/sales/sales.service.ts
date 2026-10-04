import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation } from '../../utils/databaseMutation.js';
import {
  lockRfq,
  checkVersion,
  touch,
  isAdmin,
  type Actor,
} from '../rfq/rfq.access.js';
import { responseEntitlement } from '../rfq/quote.service.js';
import { salesEvent } from './sales.sync.js';
import { Prisma } from '../../generated/client.js';
import type { SalesQuery } from './sales.validation.js';
const ExactDecimal = Prisma.Decimal.clone({ precision: 40 });
const rfqSelect = {
  id: true,
  rfqNumber: true,
  title: true,
  description: true,
  status: true,
  quantity: true,
  unit: true,
  deliveryLocation: true,
  deliveryTimeline: true,
  expiresAt: true,
  isFlagged: true,
  buyerId: true,
  buyer: { select: { displayName: true } },
  machine: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.RfqSelect;
const include = {
  recipient: {
    include: {
      rfq: { select: rfqSelect },
      recipient: {
        select: {
          id: true,
          displayName: true,
          supplier: { select: { companyName: true } },
        },
      },
      quotes: {
        orderBy: { createdAt: 'desc' as const },
        select: {
          id: true,
          status: true,
          unitPrice: true,
          currency: true,
          moq: true,
          leadTimeDays: true,
          validUntil: true,
          notes: true,
        },
      },
    },
  },
  sale: { include: { acceptedQuote: true } },
} satisfies Prisma.SalesOpportunityInclude;
type Opportunity = Prisma.SalesOpportunityGetPayload<{
  include: typeof include;
}>;
const saleInclude = {
  acceptedQuote: true,
  opportunity: {
    include: {
      recipient: {
        include: {
          rfq: { select: rfqSelect },
          recipient: {
            select: {
              displayName: true,
              supplier: { select: { companyName: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.SaleRecordInclude;
type Sale = Prisma.SaleRecordGetPayload<{ include: typeof saleInclude }>;
const pagination = (q: SalesQuery, total: number) => ({
  page: q.page,
  limit: q.limit,
  total,
  totalPages: Math.ceil(total / q.limit),
});
const dateRange = (q: SalesQuery) =>
  q.from || q.to
    ? {
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      }
    : {};
const ownerWhere = (
  a: Actor,
  admin: boolean,
): Prisma.SalesOpportunityWhereInput =>
  admin ? {} : { recipient: { recipientId: a.id } };
async function opportunity(
  tx: Prisma.TransactionClient,
  id: string,
  a: Actor,
  lock = false,
) {
  if (lock) {
    const first = await tx.salesOpportunity.findUnique({
      where: { id },
      select: { recipient: { select: { rfqId: true } } },
    });
    if (!first) throw new AppError('Opportunity not found', 404);
    await lockRfq(tx, first.recipient.rfqId);
  }
  const o = await tx.salesOpportunity.findUnique({ where: { id }, include });
  if (!o || (!isAdmin(a) && o.recipient.recipientId !== a.id))
    throw new AppError('Opportunity not found', 404);
  return o;
}
async function writable(
  tx: Prisma.TransactionClient,
  o: Opportunity,
  a: Actor,
) {
  if (o.recipient.rfq.isFlagged)
    throw new AppError('RFQ is flagged for review', 409);
  if (!isAdmin(a)) {
    if (o.recipient.removedAt)
      throw new AppError('Removed assignments are read-only', 403);
    await responseEntitlement(tx, a.id);
  }
}
async function editPermission(
  tx: Prisma.TransactionClient,
  o: Opportunity,
  a: Actor,
) {
  if (o.recipient.rfq.isFlagged)
    return {
      canEdit: false,
      readOnlyReason: 'RFQ is flagged for review. Sales changes are paused.',
    };
  if (!isAdmin(a)) {
    if (o.recipient.removedAt)
      return {
        canEdit: false,
        readOnlyReason: 'Removed assignments retain read-only history.',
      };
    try {
      await responseEntitlement(tx, a.id, false);
    } catch (error) {
      if (!(error instanceof AppError) || error.statusCode !== 403) throw error;
      return {
        canEdit: false,
        readOnlyReason: error.message + '. History remains available.',
      };
    }
  }
  return { canEdit: true, readOnlyReason: null };
}
const summary = (o: Opportunity) => ({
  id: o.id,
  stage: o.stage,
  updatedAt: o.updatedAt,
  createdAt: o.createdAt,
  leadId: o.recipientId,
  ownerId: o.recipient.recipientId,
  ownerName:
    o.recipient.recipient.supplier?.companyName ??
    o.recipient.recipient.displayName,
  assignmentRemoved: !!o.recipient.removedAt,
  rfq: o.recipient.rfq,
  sale: o.sale ? { id: o.sale.id, status: o.sale.status } : null,
});
function saleView(s: Sale) {
  const r = s.opportunity.recipient.rfq,
    q = s.acceptedQuote;
  return {
    id: s.id,
    opportunityId: s.opportunityId,
    status: s.status,
    updatedAt: s.updatedAt,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    cancelledAt: s.cancelledAt,
    cancellationReason: s.cancellationReason,
    rfq: {
      id: r.id,
      rfqNumber: r.rfqNumber,
      title: r.title,
      buyer: r.buyer,
      quantity: r.quantity,
      unit: r.unit,
      deliveryLocation: r.deliveryLocation,
      deliveryTimeline: r.deliveryTimeline,
    },
    sellerName:
      s.opportunity.recipient.recipient.supplier?.companyName ??
      s.opportunity.recipient.recipient.displayName,
    quote: {
      id: q.id,
      unitPrice: q.unitPrice,
      currency: q.currency,
      moq: q.moq,
      leadTimeDays: q.leadTimeDays,
      validUntil: q.validUntil,
      notes: q.notes,
    },
    totalAmount: new ExactDecimal(q.unitPrice.toString())
      .mul(r.quantity.toString())
      .toString(),
  };
}
export const salesService = {
  async list(a: Actor, q: SalesQuery, admin = false) {
    const base: Prisma.SalesOpportunityWhereInput = {
      ...ownerWhere(a, admin),
      ...dateRange(q),
      ...(q.q
        ? {
            recipient: {
              ...(admin ? {} : { recipientId: a.id }),
              rfq: {
                OR: [
                  { title: { contains: q.q, mode: 'insensitive' } },
                  { rfqNumber: { contains: q.q, mode: 'insensitive' } },
                ],
              },
            },
          }
        : {}),
    };
    const where = { ...base, ...(q.stage ? { stage: q.stage } : {}) };
    const [total, opportunities, groups] = await prisma.$transaction([
      prisma.salesOpportunity.count({ where }),
      prisma.salesOpportunity.findMany({
        where,
        include,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: [{ [q.sort]: q.direction }, { id: q.direction }],
      }),
      prisma.salesOpportunity.groupBy({
        by: ['stage'],
        orderBy: { stage: 'asc' },
        where: base,
        _count: true,
      }),
    ]);
    return {
      opportunities: opportunities.map(summary),
      counts: Object.fromEntries(groups.map((g) => [g.stage, g._count])),
      pagination: pagination(q, total),
    };
  },
  detail: (a: Actor, id: string) =>
    prisma.$transaction(async (tx) => {
      const o = await opportunity(tx, id, a);
      const events = await tx.salesEvent.findMany({
        where: { opportunityId: id },
        include: { actor: { select: { displayName: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return {
        ...summary(o),
        ...(await editPermission(tx, o, a)),
        internalNotes: o.internalNotes,
        quotes: o.recipient.quotes,
        events,
        sale: o.sale
          ? saleView(
              await tx.saleRecord.findUniqueOrThrow({
                where: { id: o.sale.id },
                include: saleInclude,
              }),
            )
          : null,
      };
    }),
  update: (
    a: Actor,
    id: string,
    data: {
      updatedAt: string;
      stage?: 'QUALIFIED' | 'NEGOTIATION';
      internalNotes?: string;
    },
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const o = await opportunity(tx, id, a, true);
        checkVersion(o.updatedAt, data.updatedAt);
        await writable(tx, o, a);
        if (data.stage) {
          const r = o.recipient.rfq;
          if (
            !['ROUTED', 'QUOTED'].includes(r.status) ||
            !r.expiresAt ||
            r.expiresAt <= new Date() ||
            o.recipient.removedAt
          )
            throw new AppError('Opportunity is not open', 409);
          if (!(
            (o.stage === 'NEW' && data.stage === 'QUALIFIED') ||
            (o.stage === 'QUOTED' && data.stage === 'NEGOTIATION')
          ))
            throw new AppError('Invalid sales stage transition', 409);
          if (
            data.stage === 'NEGOTIATION' &&
            !o.recipient.quotes.some(
              (q) => q.status === 'PENDING' && q.validUntil > new Date(),
            )
          )
            throw new AppError(
              'An active quote is required for negotiation',
              409,
            );
          await salesEvent(tx, id, a.id, 'STAGE_CHANGED', {
            from: o.stage,
            to: data.stage,
            source: 'SALES_WORKSPACE',
          });
        }
        if (
          data.internalNotes !== undefined &&
          data.internalNotes !== o.internalNotes
        )
          await salesEvent(tx, id, a.id, 'INTERNAL_NOTES_UPDATED');
        return tx.salesOpportunity.update({
          where: { id },
          data: {
            ...(data.stage ? { stage: data.stage } : {}),
            ...(data.internalNotes !== undefined
              ? { internalNotes: data.internalNotes }
              : {}),
            updatedAt: touch(o.updatedAt),
          },
        });
      }),
    ),
  record: (a: Actor, id: string, version: string) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const o = await opportunity(tx, id, a, true);
        checkVersion(o.updatedAt, version);
        await writable(tx, o, a);
        const winner = o.recipient.quotes.find((q) => q.status === 'ACCEPTED');
        if (
          o.stage !== 'WON' ||
          !winner ||
          !['ACCEPTED', 'CLOSED'].includes(o.recipient.rfq.status)
        )
          throw new AppError(
            'An accepted quote is required to record a sale',
            409,
          );
        if (o.sale)
          throw new AppError(
            'This accepted quote already has a sale record',
            409,
          );
        const sale = await tx.saleRecord.create({
          data: {
            opportunityId: id,
            recipientId: o.recipientId,
            acceptedQuoteId: winner.id,
            recordedById: a.id,
          },
        });
        await tx.salesOpportunity.update({
          where: { id },
          data: { updatedAt: touch(o.updatedAt) },
        });
        await salesEvent(tx, id, a.id, 'SALE_RECORDED', {
          saleId: sale.id,
          quoteId: winner.id,
        });
        return sale;
      }),
    ),
  async records(a: Actor, q: SalesQuery, admin = false) {
    const opportunityWhere: Prisma.SalesOpportunityWhereInput = admin
      ? {}
      : q.view === 'buyer'
        ? { recipient: { rfq: { buyerId: a.id } } }
        : { recipient: { recipientId: a.id } };
    const where: Prisma.SaleRecordWhereInput = {
      opportunity: opportunityWhere,
      ...dateRange(q),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            AND: [
              {
                opportunity: {
                  recipient: {
                    rfq: {
                      OR: [
                        { title: { contains: q.q, mode: 'insensitive' } },
                        { rfqNumber: { contains: q.q, mode: 'insensitive' } },
                      ],
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };
    const [total, records] = await prisma.$transaction([
      prisma.saleRecord.count({ where }),
      prisma.saleRecord.findMany({
        where,
        include: saleInclude,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        orderBy: [{ [q.sort]: q.direction }, { id: q.direction }],
      }),
    ]);
    return { records: records.map(saleView), pagination: pagination(q, total) };
  },
  sale: (a: Actor, id: string) =>
    prisma.$transaction(async (tx) => {
      const s = await tx.saleRecord.findUnique({
        where: { id },
        include: saleInclude,
      });
      if (
        !s ||
        (!isAdmin(a) &&
          s.opportunity.recipient.recipientId !== a.id &&
          s.opportunity.recipient.rfq.buyerId !== a.id)
      )
        throw new AppError('Sale record not found', 404);
      const permission =
        isAdmin(a) || s.opportunity.recipient.recipientId === a.id
          ? await editPermission(
              tx,
              await opportunity(tx, s.opportunityId, a),
              a,
            )
          : {
              canEdit: false,
              readOnlyReason: 'Buyer sale records are read-only.',
            };
      return { ...saleView(s), ...permission };
    }),
  saleUpdate: (
    a: Actor,
    id: string,
    data: {
      updatedAt: string;
      status: 'COMPLETED' | 'CANCELLED';
      reason?: string;
    },
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const first = await tx.saleRecord.findUnique({
          where: { id },
          select: { opportunityId: true },
        });
        if (!first) throw new AppError('Sale record not found', 404);
        const o = await opportunity(tx, first.opportunityId, a, true);
        await writable(tx, o, a);
        const s = await tx.saleRecord.findUniqueOrThrow({ where: { id } });
        checkVersion(s.updatedAt, data.updatedAt);
        if (s.status !== 'RECORDED')
          throw new AppError('Completed and cancelled sales are final', 409);
        const result = await tx.saleRecord.update({
          where: { id },
          data: {
            status: data.status,
            updatedAt: touch(s.updatedAt),
            ...(data.status === 'COMPLETED'
              ? { completedAt: new Date() }
              : { cancelledAt: new Date(), cancellationReason: data.reason! }),
          },
        });
        await tx.salesOpportunity.update({
          where: { id: o.id },
          data: { updatedAt: touch(o.updatedAt) },
        });
        await salesEvent(tx, o.id, a.id, `SALE_${data.status}`, {
          saleId: id,
          ...(data.reason ? { reason: data.reason } : {}),
        });
        return result;
      }),
    ),
};
