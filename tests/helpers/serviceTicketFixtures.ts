import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/config/database.js';
export async function completedPurchase(
  buyerId: string,
  recipientId: string,
  machineId: string,
  categoryId: string,
) {
  const rfq = await prisma.rfq.create({
    data: {
      rfqNumber: 'SVC-QA-' + randomUUID().slice(0, 28),
      buyerId,
      machineId,
      categoryId,
      title: 'Machinery purchase',
      description: 'PRIVATE RFQ TEXT',
      quantity: '1',
      unit: 'unit',
      deliveryLocation: 'PRIVATE ADDRESS',
      deliveryTimeline: '30 days',
      status: 'ACCEPTED',
    },
  });
  const recipient = await prisma.rfqRecipient.create({
    data: {
      rfqId: rfq.id,
      recipientId,
      recipientRole: 'SUPPLIER',
      routingReason: 'AUTO',
      leadStatus: 'CLOSED',
    },
  });
  const quote = await prisma.rfqQuote.create({
    data: {
      rfqId: rfq.id,
      recipientId: recipient.id,
      unitPrice: '98765.43',
      currency: 'USD',
      moq: '1',
      leadTimeDays: 7,
      validUntil: new Date(Date.now() + 86400000),
      notes: 'PRIVATE QUOTE NOTES',
      status: 'ACCEPTED',
    },
  });
  const opportunity = await prisma.salesOpportunity.create({
    data: {
      recipientId: recipient.id,
      stage: 'WON',
      internalNotes: 'PRIVATE SALES NOTES',
    },
  });
  const sale = await prisma.saleRecord.create({
    data: {
      opportunityId: opportunity.id,
      recipientId: recipient.id,
      acceptedQuoteId: quote.id,
      recordedById: recipientId,
      status: 'COMPLETED',
      completedAt: new Date(),
    },
  });
  return { rfq, recipient, quote, opportunity, sale };
}
export async function cleanTicketFixtures(
  userIds: string[],
  categoryId?: string,
) {
  const where = { customerId: { in: userIds } };
  await prisma.serviceTicketEvent.deleteMany({ where: { ticket: where } });
  await prisma.serviceTicket.deleteMany({ where });
  const rfqWhere = { buyerId: { in: userIds } },
    opportunity = { recipient: { rfq: rfqWhere } };
  await prisma.review.deleteMany({ where: { authorId: { in: userIds } } });
  await prisma.salesEvent.deleteMany({ where: { opportunity } });
  await prisma.saleRecord.deleteMany({ where: { opportunity } });
  await prisma.salesOpportunity.deleteMany({ where: opportunity });
  await prisma.rfqEmailDelivery.deleteMany({
    where: { event: { rfq: rfqWhere } },
  });
  await prisma.rfqEvent.deleteMany({ where: { rfq: rfqWhere } });
  await prisma.rfqMessage.deleteMany({ where: { rfq: rfqWhere } });
  await prisma.rfqQuoteAttachment.deleteMany({
    where: { quote: { rfq: rfqWhere } },
  });
  await prisma.rfqQuote.deleteMany({ where: { rfq: rfqWhere } });
  await prisma.rfqAttachment.deleteMany({ where: { rfq: rfqWhere } });
  await prisma.rfqRecipient.deleteMany({ where: { rfq: rfqWhere } });
  await prisma.rfq.deleteMany({ where: rfqWhere });
  if (categoryId) {
    await prisma.machineMedia.deleteMany({
      where: { machine: { categoryId } },
    });
    await prisma.machine.deleteMany({ where: { categoryId } });
    await prisma.machineCategory.deleteMany({ where: { id: categoryId } });
  }
  const suppliers = await prisma.supplier.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  await prisma.supplierSubscription.deleteMany({
    where: { supplierId: { in: suppliers.map((s) => s.id) } },
  });
  await prisma.supplier.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
