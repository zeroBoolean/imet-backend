import { syncSalesForRfq } from '../sales/sales.sync.js';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation } from '../../utils/databaseMutation.js';
import {
  lockRfq,
  requireOpen,
  checkVersion,
  touch,
  type Actor,
} from './rfq.access.js';
import {
  effectiveState,
  lockSupplier,
} from '../subscription/subscription.entitlements.js';
import { rfqEvent, closeRfqLeads } from './rfqEvent.service.js';
import type { QuoteInput, QuoteQuery } from './rfq.validation.js';
import type { Prisma } from '../../generated/client.js';
export async function responseEntitlement(
  tx: Prisma.TransactionClient,
  userId: string,
  lock = true,
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: {
      assignedRole: { select: { role: true } },
      supplier: { select: { id: true } },
      status: true,
      isEmailVerified: true,
    },
  });
  if (!user || user.status !== 'ACTIVE' || !user.isEmailVerified)
    throw new AppError('Active account required', 403);
  if (user.assignedRole.some((r) => r.role === 'SALES_PERSON')) return;
  if (!user.supplier) throw new AppError('Supplier profile required', 403);
  const s = lock
    ? await lockSupplier(tx, user.supplier.id)
    : await tx.supplier.findUnique({
        where: { id: user.supplier.id },
        include: { subscriptions: { where: { isCurrent: true } } },
      });
  if (!s) throw new AppError('Supplier profile required', 403);
  const t = s.subscriptions[0];
  if (
    s.status !== 'APPROVED' ||
    !user.assignedRole.some(
      (r) =>
        r.role ===
        (s.type === 'LOCAL' ? 'LOCAL_SUPPLIER' : 'INTERNATIONAL_MANUFACTURER'),
    ) ||
    !t ||
    effectiveState(t) !== 'ACTIVE' ||
    t.supplierType !== s.type ||
    !t.rfqEnabled
  )
    throw new AppError('Active RFQ subscription entitlement required', 403);
}
export const quoteService = {
  create: (a: Actor, rfqId: string, input: QuoteInput) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const r = await requireOpen(tx, rfqId);
        const lead = await tx.rfqRecipient.findUnique({
          where: { rfqId_recipientId: { rfqId, recipientId: a.id } },
        });
        if (!lead || lead.removedAt) throw new AppError('Lead not found', 404);
        if (['DECLINED', 'CLOSED'].includes(lead.leadStatus))
          throw new AppError('Lead is closed', 409);
        await responseEntitlement(tx, a.id);
        if (
          await tx.rfqQuote.count({
            where: { recipientId: lead.id, status: 'PENDING' },
          })
        )
          throw new AppError('Edit or withdraw your pending quote first', 409);
        const quote = await tx.rfqQuote.create({
          data: {
            ...input,
            validUntil: new Date(input.validUntil),
            rfqId,
            recipientId: lead.id,
          },
        });
        await tx.rfqRecipient.update({
          where: { id: lead.id },
          data: { leadStatus: 'QUOTED', respondedAt: new Date() },
        });
        await rfqEvent(
          tx,
          rfqId,
          a.id,
          'QUOTE_CREATED',
          { quoteId: quote.id },
          [r.buyerId],
        );
        if (r.status !== 'QUOTED') {
          await tx.rfq.update({
            where: { id: rfqId },
            data: { status: 'QUOTED', updatedAt: touch(r.updatedAt) },
          });
          await rfqEvent(tx, rfqId, a.id, 'QUOTED');
        } else
          await tx.rfq.update({
            where: { id: rfqId },
            data: { updatedAt: touch(r.updatedAt) },
          });
        await syncSalesForRfq(tx, rfqId, a.id);
        return quote;
      }),
    ),
  edit: (a: Actor, id: string, input: QuoteInput & { updatedAt: string }) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const initial = await tx.rfqQuote.findUnique({
          where: { id },
          select: { rfqId: true },
        });
        if (!initial) throw new AppError('Quote not found', 404);
        const r = await requireOpen(tx, initial.rfqId);
        const old = await tx.rfqQuote.findUniqueOrThrow({
          where: { id },
          include: { recipient: true },
        });
        if (old.recipient.recipientId !== a.id || old.recipient.removedAt)
          throw new AppError('Quote not found', 404);
        checkVersion(old.updatedAt, input.updatedAt);
        if (old.status !== 'PENDING')
          throw new AppError('Only pending quotes can be edited', 409);
        await responseEntitlement(tx, a.id);
        const { updatedAt, ...data } = input;
        void updatedAt;
        const quote = await tx.rfqQuote.update({
          where: { id },
          data: {
            ...data,
            validUntil: new Date(data.validUntil),
            updatedAt: touch(old.updatedAt),
          },
        });
        await tx.rfq.update({
          where: { id: r.id },
          data: { updatedAt: touch(r.updatedAt) },
        });
        await rfqEvent(tx, r.id, a.id, 'QUOTE_UPDATED', { quoteId: id }, [
          r.buyerId,
        ]);
        return quote;
      }),
    ),
  action: (
    a: Actor,
    id: string,
    action: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN',
    version: string,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const old = await tx.rfqQuote.findUnique({
          where: { id },
          include: { recipient: true },
        });
        if (!old) throw new AppError('Quote not found', 404);
        const r = await lockRfq(tx, old.rfqId);
        if (
          action === 'WITHDRAWN'
            ? old.recipient.recipientId !== a.id
            : r.buyerId !== a.id
        )
          throw new AppError('Quote not found', 404);
        // Re-read after the RFQ lock: another transaction may have accepted/rejected this quote.
        const quote = await tx.rfqQuote.findUniqueOrThrow({
          where: { id },
          include: { recipient: true },
        });
        checkVersion(quote.updatedAt, version);
        if (
          quote.status !== 'PENDING' ||
          !['ROUTED', 'QUOTED'].includes(r.status) ||
          quote.recipient.removedAt
        )
          throw new AppError(
            'Quote cannot be changed in its current state',
            409,
          );
        if (action === 'ACCEPTED') {
          if (
            r.isFlagged ||
            !r.expiresAt ||
            r.expiresAt <= new Date() ||
            quote.validUntil <= new Date()
          )
            throw new AppError('RFQ or quote is expired or flagged', 409);
          await responseEntitlement(tx, old.recipient.recipientId);
          const rejected = await tx.rfqQuote.findMany({
            where: { rfqId: r.id, id: { not: id }, status: 'PENDING' },
            include: { recipient: { select: { recipientId: true } } },
          });
          await tx.rfqQuote.updateMany({
            where: { rfqId: r.id, id: { not: id }, status: 'PENDING' },
            data: { status: 'REJECTED' },
          });
          for (const q of rejected)
            await rfqEvent(
              tx,
              r.id,
              a.id,
              'QUOTE_REJECTED',
              { quoteId: q.id, reason: 'Another quote accepted' },
              [q.recipient.recipientId],
            );
          await tx.rfq.update({
            where: { id: r.id },
            data: { status: 'ACCEPTED', updatedAt: touch(r.updatedAt) },
          });
          await closeRfqLeads(tx, r.id, a.id, 'ACCEPTED');
          await rfqEvent(tx, r.id, a.id, 'ACCEPTED', { quoteId: id }, [
            r.buyerId,
            old.recipient.recipientId,
          ]);
        } else {
          await tx.rfq.update({
            where: { id: r.id },
            data: { updatedAt: touch(r.updatedAt) },
          });
          await rfqEvent(
            tx,
            r.id,
            a.id,
            action === 'REJECTED' ? 'QUOTE_REJECTED' : 'QUOTE_WITHDRAWN',
            { quoteId: id },
            [action === 'REJECTED' ? old.recipient.recipientId : r.buyerId],
          );
        }
        const result = await tx.rfqQuote.update({
          where: { id },
          data: { status: action, updatedAt: touch(quote.updatedAt) },
        });
        await syncSalesForRfq(tx, r.id, a.id);
        return result;
      }),
    ),
  async list(a: Actor, q: QuoteQuery) {
    const where: Prisma.RfqQuoteWhereInput = {
      recipient: { recipientId: a.id },
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            rfq: {
              OR: [
                { title: { contains: q.q, mode: 'insensitive' } },
                { rfqNumber: { contains: q.q, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };
    const [total, quotes] = await prisma.$transaction([
      prisma.rfqQuote.count({ where }),
      prisma.rfqQuote.findMany({
        where,
        include: {
          rfq: {
            select: { id: true, rfqNumber: true, title: true, status: true },
          },
          attachments: {
            select: {
              id: true,
              fileName: true,
              fileSize: true,
              fileType: true,
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      quotes,
      pagination: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.ceil(total / q.limit),
      },
    };
  },
};
