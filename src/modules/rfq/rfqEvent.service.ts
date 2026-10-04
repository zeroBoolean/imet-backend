import type { Prisma } from '../../generated/client.js';
export async function rfqEvent(
  tx: Prisma.TransactionClient,
  rfqId: string,
  actorId: string | null,
  eventType: string,
  metadata: Prisma.InputJsonValue = {},
  users: string[] = [],
) {
  const event = await tx.rfqEvent.create({
    data: { rfqId, actorId, eventType, metadata },
  });
  if (users.length)
    await tx.rfqEmailDelivery.createMany({
      data: [...new Set(users)].map((userId) => ({
        eventId: event.id,
        userId,
      })),
      skipDuplicates: true,
    });
  return event;
}

export async function closeRfqLeads(
  tx: Prisma.TransactionClient,
  rfqId: string,
  actorId: string | null,
  reason: string,
) {
  const leads = await tx.rfqRecipient.findMany({
    where: { rfqId, removedAt: null, leadStatus: { not: 'CLOSED' } },
    select: { id: true, recipientId: true },
  });
  await tx.rfqRecipient.updateMany({
    where: { rfqId, removedAt: null, leadStatus: { not: 'CLOSED' } },
    data: { leadStatus: 'CLOSED' },
  });
  for (const lead of leads)
    await rfqEvent(tx, rfqId, actorId, 'LEAD_CLOSED', {
      recipientId: lead.id,
      reason,
    });
}
