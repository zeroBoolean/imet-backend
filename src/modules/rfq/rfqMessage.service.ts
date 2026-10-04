import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { isAdmin, rfqAccess, lockRfq, type Actor } from './rfq.access.js';
import type { Prisma } from '../../generated/client.js';
import { rfqEvent } from './rfqEvent.service.js';
async function threadAccess(
  tx: Prisma.TransactionClient,
  a: Actor,
  rfqId: string,
  recipientId: string,
) {
  const r = await rfqAccess(tx, rfqId, a);
  const lead = await tx.rfqRecipient.findFirst({
    where: { id: recipientId, rfqId },
  });
  if (
    !lead ||
    (!isAdmin(a) &&
      r.buyerId !== a.id &&
      (lead.recipientId !== a.id || lead.removedAt))
  )
    throw new AppError('Thread not found', 404);
  return { r, lead };
}
export const rfqMessageService = {
  list: (a: Actor, rfqId: string, recipientId: string, before?: string) =>
    prisma.$transaction(async (tx) => {
      const { r, lead } = await threadAccess(tx, a, rfqId, recipientId);
      if (a.id === r.buyerId || a.id === lead.recipientId)
        await tx.rfqMessage.updateMany({
          where: { rfqId, recipientId, senderId: { not: a.id }, readAt: null },
          data: { readAt: new Date() },
        });
      return tx.rfqMessage.findMany({
        where: {
          rfqId,
          recipientId,
          ...(before ? { createdAt: { lt: new Date(before) } } : {}),
        },
        select: {
          id: true,
          body: true,
          senderId: true,
          sender: { select: { displayName: true } },
          createdAt: true,
          readAt: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
    }),
  send: (a: Actor, rfqId: string, recipientId: string, body: string) =>
    prisma.$transaction(async (tx) => {
      const r = await lockRfq(tx, rfqId);
      const { lead } = await threadAccess(tx, a, rfqId, recipientId);
      if (
        ['DRAFT', 'CANCELLED', 'CLOSED', 'EXPIRED', 'DECLINED'].includes(
          r.status,
        ) ||
        r.isFlagged ||
        lead.removedAt ||
        (r.status !== 'ACCEPTED' && r.expiresAt && r.expiresAt <= new Date())
      )
        throw new AppError('This conversation is closed', 409);
      const message = await tx.rfqMessage.create({
        data: { rfqId, recipientId, senderId: a.id, body },
      });
      await rfqEvent(
        tx,
        rfqId,
        a.id,
        'MESSAGE_SENT',
        { messageId: message.id, recipientId },
        a.id === r.buyerId
          ? [lead.recipientId]
          : a.id === lead.recipientId
            ? [r.buyerId]
            : [r.buyerId, lead.recipientId],
      );
      return message;
    }),
};
