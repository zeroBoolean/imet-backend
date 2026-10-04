import type { QuoteQuery } from './rfq.validation.js';
import { effectiveState } from '../subscription/subscription.entitlements.js';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { lockRfq, touch, type Actor } from './rfq.access.js';
import { rfqEvent } from './rfqEvent.service.js';
export const leadService = {
  async rfqId(a: Actor, id: string) {
    const lead = await prisma.rfqRecipient.findFirst({
      where: { id, recipientId: a.id, removedAt: null },
    });
    if (!lead) throw new AppError('Lead not found', 404);
    return lead.rfqId;
  },
  action: (a: Actor, id: string, decline = false) =>
    prisma.$transaction(async (tx) => {
      const lead = await tx.rfqRecipient.findFirst({
        where: { id, recipientId: a.id, removedAt: null },
      });
      if (!lead) throw new AppError('Lead not found', 404);
      const r = await lockRfq(tx, lead.rfqId);
      const current = await tx.rfqRecipient.findUniqueOrThrow({
        where: { id },
      });
      if (current.removedAt) throw new AppError('Lead not found', 404);
      if (
        !['ROUTED', 'QUOTED'].includes(r.status) ||
        !r.expiresAt ||
        r.expiresAt <= new Date() ||
        r.isFlagged
      )
        throw new AppError('Lead is not open', 409);
      if (decline) {
        if (['CLOSED', 'DECLINED'].includes(current.leadStatus))
          throw new AppError('Lead is already final', 409);
        if (
          await tx.rfqQuote.count({
            where: { recipientId: id, status: 'PENDING' },
          })
        )
          throw new AppError(
            'Withdraw your pending quote before declining',
            409,
          );
        await tx.rfqRecipient.update({
          where: { id },
          data: { leadStatus: 'DECLINED', respondedAt: new Date() },
        });
        await rfqEvent(tx, r.id, a.id, 'LEAD_DECLINED', { recipientId: id }, [
          r.buyerId,
        ]);
        const remaining = await tx.rfqRecipient.count({
          where: {
            rfqId: r.id,
            removedAt: null,
            leadStatus: { not: 'DECLINED' },
          },
        });
        if (!remaining) {
          await tx.rfq.update({
            where: { id: r.id },
            data: { status: 'DECLINED', updatedAt: touch(r.updatedAt) },
          });
          await rfqEvent(tx, r.id, a.id, 'DECLINED', {}, [r.buyerId]);
        } else
          await tx.rfq.update({
            where: { id: r.id },
            data: { updatedAt: touch(r.updatedAt) },
          });
      } else if (current.leadStatus === 'NEW') {
        await tx.rfqRecipient.update({
          where: { id },
          data: { leadStatus: 'VIEWED', viewedAt: new Date() },
        });
        await rfqEvent(tx, r.id, a.id, 'LEAD_VIEWED', { recipientId: id });
      }
      return tx.rfqRecipient.findUniqueOrThrow({ where: { id } });
    }),
  async overview(q: Pick<QuoteQuery, 'page' | 'limit' | 'q'>) {
    const now = new Date();
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const where = q.q
      ? { companyName: { contains: q.q, mode: 'insensitive' as const } }
      : {};
    const [total, suppliers] = await prisma.$transaction([
      prisma.supplier.count({ where }),
      prisma.supplier.findMany({
        where,
        select: {
          id: true,
          companyName: true,
          userId: true,
          type: true,
          status: true,
          subscriptions: {
            where: { isCurrent: true },
            select: {
              rfqEnabled: true,
              leadLimitPerMonth: true,
              state: true,
              startsAt: true,
              endsAt: true,
              supplierType: true,
            },
          },
        },
        orderBy: [{ companyName: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    const ids = suppliers.map((s) => s.userId);
    const [counts, responses, usage] = await Promise.all([
      prisma.rfqRecipient.groupBy({
        by: ['recipientId'],
        where: { recipientId: { in: ids } },
        _count: true,
      }),
      prisma.rfqRecipient.groupBy({
        by: ['recipientId'],
        where: { recipientId: { in: ids }, respondedAt: { not: null } },
        _count: true,
      }),
      prisma.rfqRecipient.groupBy({
        by: ['recipientId'],
        where: { recipientId: { in: ids }, quotaMonth: month },
        _count: true,
      }),
    ]);
    const rows = suppliers.map((s) => {
      const count = counts.find((c) => c.recipientId === s.userId)?._count ?? 0;
      const responded =
        responses.find((c) => c.recipientId === s.userId)?._count ?? 0;
      const term = s.subscriptions[0];
      return {
        id: s.id,
        companyName: s.companyName,
        totalLeads: count,
        responses: responded,
        responseRate: count ? Math.round((responded * 100) / count) : 0,
        monthlyUsage:
          usage.find((c) => c.recipientId === s.userId)?._count ?? 0,
        leadLimitPerMonth: term?.leadLimitPerMonth ?? null,
        rfqEnabled:
          !!term &&
          term.rfqEnabled &&
          effectiveState(term) === 'ACTIVE' &&
          term.supplierType === s.type &&
          s.status === 'APPROVED',
      };
    });
    return {
      suppliers: rows,
      pagination: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.ceil(total / q.limit),
      },
    };
  },
};
