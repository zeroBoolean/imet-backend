import type { Prisma, Rfq, RfqRoutingReason } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  effectiveState,
  lockSupplier,
  publicSupplierWhere,
} from '../subscription/subscription.entitlements.js';
import { rfqEvent } from './rfqEvent.service.js';
export async function routeRecipients(
  tx: Prisma.TransactionClient,
  rfq: Rfq,
  userIds: string[] | undefined,
  reason: RfqRoutingReason,
  actorId: string | null,
) {
  let candidates: string[];
  if (userIds) candidates = [...new Set(userIds)].sort();
  else {
    const machine = rfq.machineId
      ? await tx.machine.findUnique({
          where: { id: rfq.machineId },
          select: { supplierId: true },
        })
      : null;
    const suppliers = await tx.supplier.findMany({
      where: {
        ...publicSupplierWhere(),
        ...(machine?.supplierId
          ? { id: machine.supplierId }
          : rfq.categoryId
            ? {
                machines: {
                  some: { categoryId: rfq.categoryId, status: 'PUBLISHED' },
                },
              }
            : { id: { in: [] } }),
        ...(rfq.supplierCountry
          ? { country: { equals: rfq.supplierCountry, mode: 'insensitive' } }
          : {}),
      },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    candidates = suppliers.map((s) => s.userId);
  }
  const added: string[] = [];
  const skipped: { userId: string; reason: string }[] = [];
  for (const userId of candidates) {
    if (userId === rfq.buyerId) {
      skipped.push({ userId, reason: 'Buyer cannot receive their own RFQ' });
      continue;
    }
    const existing = await tx.rfqRecipient.findUnique({
      where: { rfqId_recipientId: { rfqId: rfq.id, recipientId: userId } },
    });
    if (existing && !existing.removedAt) continue;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        isEmailVerified: true,
        assignedRole: { select: { role: true } },
        supplier: { select: { id: true } },
      },
    });
    if (!user || user.status !== 'ACTIVE' || !user.isEmailVerified) {
      skipped.push({ userId, reason: 'Account is unavailable' });
      continue;
    }
    const roles = user.assignedRole.map((r) => r.role);
    let recipientRole: 'SALESPERSON' | 'SELLER' | 'SUPPLIER' | 'MANUFACTURER';
    let quotaMonth: Date | null = null;
    if (roles.includes('SALES_PERSON')) recipientRole = 'SALESPERSON';
    else {
      if (!user.supplier) {
        skipped.push({ userId, reason: 'Approved supplier profile required' });
        continue;
      }
      const supplier = await lockSupplier(tx, user.supplier.id);
      const term = supplier.subscriptions[0];
      if (
        supplier.status !== 'APPROVED' ||
        !supplier.marketplaceVisible ||
        !roles.includes(
          supplier.type === 'LOCAL'
            ? 'LOCAL_SUPPLIER'
            : 'INTERNATIONAL_MANUFACTURER',
        ) ||
        !term ||
        effectiveState(term) !== 'ACTIVE' ||
        term.supplierType !== supplier.type ||
        !term.rfqEnabled ||
        term.visibility === 'HIDDEN'
      ) {
        skipped.push({
          userId,
          reason: 'Active RFQ subscription entitlement required',
        });
        continue;
      }
      const now = new Date();
      quotaMonth =
        existing?.quotaMonth ??
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const month = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const usage = await tx.rfqRecipient.count({
        where: { recipientId: userId, quotaMonth: month },
      });
      if (
        !existing &&
        term.leadLimitPerMonth !== null &&
        usage >= term.leadLimitPerMonth
      ) {
        skipped.push({ userId, reason: 'Monthly lead cap reached' });
        continue;
      }
      recipientRole = roles.includes('INDEPENDENT_SELLER')
        ? 'SELLER'
        : supplier.type === 'LOCAL'
          ? 'SUPPLIER'
          : 'MANUFACTURER';
    }
    if (existing)
      await tx.rfqRecipient.update({
        where: { id: existing.id },
        data: {
          removedAt: null,
          leadStatus: 'NEW',
          routingReason: reason,
          routedAt: new Date(),
          quotaMonth,
          updatedAt: new Date(),
        },
      });
    else
      await tx.rfqRecipient.create({
        data: {
          rfqId: rfq.id,
          recipientId: userId,
          recipientRole,
          routingReason: reason,
          quotaMonth,
        },
      });
    added.push(userId);
  }
  if (
    !userIds &&
    !(await tx.rfqRecipient.count({
      where: { rfqId: rfq.id, removedAt: null },
    }))
  ) {
    const sales = await tx.user.findMany({
      where: {
        id: { not: rfq.buyerId },
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { some: { role: 'SALES_PERSON' } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const user of sales) {
      const old = await tx.rfqRecipient.findUnique({
        where: { rfqId_recipientId: { rfqId: rfq.id, recipientId: user.id } },
      });
      if (old && !old.removedAt) continue;
      await tx.rfqRecipient.upsert({
        where: { rfqId_recipientId: { rfqId: rfq.id, recipientId: user.id } },
        create: {
          rfqId: rfq.id,
          recipientId: user.id,
          recipientRole: 'SALESPERSON',
          routingReason: reason,
        },
        update: { removedAt: null, leadStatus: 'NEW', routingReason: reason },
      });
      added.push(user.id);
    }
  }
  if (added.length)
    await rfqEvent(
      tx,
      rfq.id,
      actorId,
      'RECIPIENTS_ADDED',
      { userIds: added, reason },
      added,
    );
  if (skipped.length)
    await rfqEvent(tx, rfq.id, actorId, 'ROUTING_SKIPPED', { skipped, reason });
  if (userIds && !added.length && skipped.length)
    throw new AppError(skipped.map((s) => s.reason).join('; '), 409);
  return { added, skipped };
}
