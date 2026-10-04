import { syncSalesForRfq } from '../sales/sales.sync.js';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import { getEmailQueue } from '../../emails/queue.js';
import { rfqEmail } from '../../emails/templates/rfqEmail.js';
import { rfqEvent, closeRfqLeads } from './rfqEvent.service.js';
import { lockRfq, touch } from './rfq.access.js';
export async function expireRfqs(now = new Date()) {
  const due = await prisma.rfq.findMany({
    where: {
      status: { in: ['SUBMITTED', 'ROUTED', 'QUOTED'] },
      expiresAt: { lte: now },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 100,
  });
  for (const { id } of due)
    await prisma.$transaction(async (tx) => {
      const r = await lockRfq(tx, id);
      if (
        !['SUBMITTED', 'ROUTED', 'QUOTED'].includes(r.status) ||
        !r.expiresAt ||
        r.expiresAt > now
      )
        return;
      const leads = await tx.rfqRecipient.findMany({
        where: { rfqId: id, removedAt: null },
      });
      const quotes = await tx.rfqQuote.findMany({
        where: { rfqId: id, status: 'PENDING' },
        select: { id: true },
      });
      await tx.rfqQuote.updateMany({
        where: { rfqId: id, status: 'PENDING' },
        data: { status: 'WITHDRAWN' },
      });
      for (const q of quotes)
        await rfqEvent(tx, id, null, 'QUOTE_WITHDRAWN', {
          quoteId: q.id,
          reason: 'EXPIRED',
        });
      await closeRfqLeads(tx, id, null, 'EXPIRED');
      await tx.rfq.update({
        where: { id },
        data: { status: 'EXPIRED', updatedAt: touch(r.updatedAt) },
      });
      await rfqEvent(tx, id, null, 'EXPIRED', {}, [
        r.buyerId,
        ...leads.map((l) => l.recipientId),
      ]);
      await syncSalesForRfq(tx, id);
    });
  const reminderDue = await prisma.rfq.findMany({
    where: {
      status: { in: ['ROUTED', 'QUOTED'] },
      recipients: {
        some: {
          removedAt: null,
          leadStatus: { in: ['NEW', 'VIEWED'] },
          reminderSentAt: null,
        },
      },
      expiresAt: {
        gt: now,
        lte: new Date(now.getTime() + config.RFQ_REMINDER_DAYS * 86400000),
      },
    },
    select: { id: true },
    take: 100,
  });
  for (const { id } of reminderDue)
    await prisma.$transaction(async (tx) => {
      const r = await lockRfq(tx, id);
      if (
        !['ROUTED', 'QUOTED'].includes(r.status) ||
        !r.expiresAt ||
        r.expiresAt <= now
      )
        return;
      const leads = await tx.rfqRecipient.findMany({
        where: {
          rfqId: id,
          removedAt: null,
          leadStatus: { in: ['NEW', 'VIEWED'] },
          reminderSentAt: null,
        },
      });
      for (const lead of leads) {
        await tx.rfqRecipient.update({
          where: { id: lead.id },
          data: { reminderSentAt: now },
        });
        await rfqEvent(
          tx,
          id,
          null,
          'EXPIRY_REMINDER',
          { recipientId: lead.id },
          [lead.recipientId],
        );
      }
    });
  return due.length;
}
export async function dispatchRfqEmails() {
  const pending = await prisma.rfqEmailDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      user: { status: 'ACTIVE' },
      attempts: { lt: 5 },
    },
    include: {
      user: {
        select: { id: true, email: true, displayName: true, status: true },
      },
      event: {
        include: {
          rfq: {
            select: { id: true, rfqNumber: true, title: true, buyerId: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const delivery of pending) {
    if (delivery.user.status !== 'ACTIVE') continue;
    const r = delivery.event.rfq;
    const lead = await prisma.rfqRecipient.findUnique({
      where: {
        rfqId_recipientId: { rfqId: r.id, recipientId: delivery.userId },
      },
      select: { id: true },
    });
    const path =
      r.buyerId === delivery.userId
        ? `/dashboard/rfqs/${r.id}`
        : lead
          ? `/dashboard/leads/${lead.id}`
          : `/dashboard/admin/rfqs/${r.id}`;
    try {
      const previous = await getEmailQueue().getJob(delivery.id);
      if (previous && (await previous.getState()) === 'failed')
        await previous.retry();
      await getEmailQueue().add(
        'rfq',
        {
          to: delivery.user.email,
          subject: `${r.rfqNumber} · ${delivery.event.eventType.replaceAll('_', ' ')} — iMet`,
          html: rfqEmail(
            delivery.user.displayName,
            r.rfqNumber,
            r.title,
            delivery.event.eventType,
            new URL(path, config.FRONTEND_URL).toString(),
          ),
          rfqDeliveryId: delivery.id,
        },
        { jobId: delivery.id, removeOnComplete: false },
      );
      await prisma.rfqEmailDelivery.updateMany({
        where: { id: delivery.id, status: { in: ['PENDING', 'FAILED'] } },
        data: {
          status: 'QUEUED',
          queuedAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
    } catch {
      await prisma.rfqEmailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          lastError: 'Email dispatch failed',
          attempts: { increment: 1 },
        },
      });
    }
  }
  return pending.length;
}
