import type { Prisma, SalesStage } from '../../generated/client.js';
export async function salesEvent(
  tx: Prisma.TransactionClient,
  opportunityId: string,
  actorId: string | null,
  eventType: string,
  metadata: Prisma.InputJsonValue = {},
) {
  return tx.salesEvent.create({
    data: { opportunityId, actorId, eventType, metadata },
  });
}
/** Called inside the existing RFQ transaction, after its authoritative outcome is saved. */
export async function syncSalesForRfq(
  tx: Prisma.TransactionClient,
  rfqId: string,
  actorId: string | null = null,
) {
  const rfq = await tx.rfq.findUniqueOrThrow({
    where: { id: rfqId },
    include: {
      recipients: {
        include: { opportunity: true, quotes: { select: { status: true } } },
      },
    },
  });
  for (const lead of rfq.recipients) {
    const winner = lead.quotes.some((q) => q.status === 'ACCEPTED');
    const lost =
      !!lead.removedAt ||
      lead.leadStatus === 'DECLINED' ||
      ['ACCEPTED', 'CLOSED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(
        rfq.status,
      );
    let stage: SalesStage = winner
      ? 'WON'
      : lost
        ? 'LOST'
        : lead.quotes.some((q) => ['PENDING', 'REJECTED'].includes(q.status))
          ? 'QUOTED'
          : 'NEW';
    const old = lead.opportunity;
    if (old && !winner && !lost) {
      if (old.stage === 'NEGOTIATION') stage = 'NEGOTIATION';
      else if (old.stage === 'QUALIFIED' && stage === 'NEW')
        stage = 'QUALIFIED';
      else if (old.stage === 'QUOTED' && stage === 'NEW') stage = 'QUOTED';
    }
    if (!old) {
      const opportunity = await tx.salesOpportunity.create({
        data: { recipientId: lead.id, stage },
      });
      await salesEvent(tx, opportunity.id, actorId, 'OPPORTUNITY_CREATED', {
        stage,
      });
    } else if (old.stage !== stage) {
      await tx.salesOpportunity.update({
        where: { id: old.id },
        data: {
          stage,
          updatedAt: new Date(
            Math.max(Date.now(), old.updatedAt.getTime() + 1),
          ),
        },
      });
      await salesEvent(tx, old.id, actorId, 'STAGE_CHANGED', {
        from: old.stage,
        to: stage,
        source: 'M5_OUTCOME',
      });
    }
  }
}
