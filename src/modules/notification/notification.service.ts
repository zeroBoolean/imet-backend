import type {
  Prisma,
  ServiceTicket,
  ServiceTicketEvent,
} from '../../generated/client.js';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import {
  serviceEmail,
  serviceEventLabels,
} from '../../emails/templates/serviceEmail.js';
import { rfqEmail, rfqEmailText } from '../../emails/templates/rfqEmail.js';
import type { EmailJob } from '../../emails/queue.js';

// Only these committed, public workflow events trigger new service email.
export async function recordServiceNotifications(
  tx: Prisma.TransactionClient,
  ticket: ServiceTicket,
  event: ServiceTicketEvent,
) {
  if (
    event.visibility !== 'PUBLIC' ||
    !Object.hasOwn(serviceEventLabels, event.type)
  )
    return;
  const recipients = new Set<string>();
  if (event.type === 'TICKET_CREATED' || ticket.customerId !== event.actorId)
    recipients.add(ticket.customerId);
  if (event.type === 'TICKET_CREATED') {
    const admins = await tx.user.findMany({
      where: {
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { some: { role: 'ADMIN' } },
      },
      select: { id: true },
    });
    for (const admin of admins)
      if (admin.id !== event.actorId) recipients.add(admin.id);
  }
  if (
    event.type === 'TICKET_ASSIGNED' &&
    event.assignedToId &&
    event.assignedToId !== event.actorId
  )
    recipients.add(event.assignedToId);
  if (recipients.size)
    await tx.notificationEmailDelivery.createMany({
      data: [...recipients].map((userId) => ({ eventId: event.id, userId })),
      skipDuplicates: true,
    });
}
export type DeliveryKind = 'service' | 'rfq';
const userSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  isEmailVerified: true,
  assignedRole: { select: { role: true } },
} satisfies Prisma.UserSelect;
const serviceRoles = [
  'LOCAL_SUPPLIER',
  'INTERNATIONAL_MANUFACTURER',
  'INDEPENDENT_SELLER',
  'SALES_PERSON',
  'ADMIN',
];
// Refresh recipients and content at dispatch AND immediately before provider delivery.
// Private descriptions/notes/prices/contacts are deliberately not selected.
export async function prepareNotificationEmail(
  kind: DeliveryKind,
  id: string,
): Promise<EmailJob | null> {
  if (kind === 'service') {
    const d = await prisma.notificationEmailDelivery.findUnique({
      where: { id },
      select: {
        user: { select: userSelect },
        event: {
          select: {
            type: true,
            assignedToId: true,
            visibility: true,
            ticket: {
              select: {
                id: true,
                sequence: true,
                customerId: true,
                assignedToId: true,
              },
            },
          },
        },
      },
    });
    if (
      !d ||
      d.user.status !== 'ACTIVE' ||
      !d.user.isEmailVerified ||
      d.event.visibility !== 'PUBLIC'
    )
      return null;
    const roles = d.user.assignedRole.map((r) => r.role);
    const ticket = d.event.ticket;
    let path: string;
    if (d.user.id === ticket.customerId && roles.includes('BUYER'))
      path = `/dashboard/service-tickets/${ticket.id}`;
    else if (roles.includes('ADMIN')) {
      if (
        d.event.type !== 'TICKET_CREATED' &&
        d.event.assignedToId !== ticket.assignedToId
      )
        return null;
      path = `/dashboard/admin/service-tickets/${ticket.id}`;
    } else if (
      d.event.type === 'TICKET_ASSIGNED' &&
      d.user.id === ticket.assignedToId &&
      d.event.assignedToId === ticket.assignedToId &&
      roles.some((role) => serviceRoles.includes(role))
    )
      path = `/dashboard/service-management/${ticket.id}`;
    else return null;
    const number = `SVC-${String(ticket.sequence).padStart(6, '0')}`;
    const content = serviceEmail(
      d.user.displayName,
      number,
      d.event.type,
      new URL(path, config.FRONTEND_URL).toString(),
    );
    if (!content) return null;
    return { to: d.user.email, ...content, notificationDeliveryId: id };
  }
  const d = await prisma.rfqEmailDelivery.findUnique({
    where: { id },
    select: {
      user: { select: userSelect },
      event: {
        select: {
          eventType: true,
          rfq: {
            select: {
              id: true,
              rfqNumber: true,
              buyerId: true,
              recipients: {
                select: { id: true, recipientId: true, removedAt: true },
              },
            },
          },
        },
      },
    },
  });
  if (!d || d.user.status !== 'ACTIVE' || !d.user.isEmailVerified) return null;
  const r = d.event.rfq;
  const roles = d.user.assignedRole.map((a) => a.role);
  const lead = r.recipients.find((a) => a.recipientId === d.user.id);
  let path: string;
  if (r.buyerId === d.user.id && roles.includes('BUYER'))
    path = `/dashboard/rfqs/${r.id}`;
  else if (roles.includes('ADMIN')) path = `/dashboard/admin/rfqs/${r.id}`;
  else if (
    lead &&
    !lead.removedAt &&
    roles.some((role) => serviceRoles.includes(role))
  )
    path = `/dashboard/leads/${lead.id}`;
  else if (
    lead &&
    lead.removedAt &&
    d.event.eventType === 'RECIPIENT_REMOVED' &&
    roles.some((role) => serviceRoles.includes(role))
  )
    path = '/dashboard/leads';
  else return null;
  const link = new URL(path, config.FRONTEND_URL).toString();
  return {
    to: d.user.email,
    subject: `${r.rfqNumber} · ${d.event.eventType.replaceAll('_', ' ')} — iMet`,
    html: rfqEmail(
      d.user.displayName,
      r.rfqNumber,
      '',
      d.event.eventType,
      link,
    ),
    text: rfqEmailText(
      d.user.displayName,
      r.rfqNumber,
      d.event.eventType,
      link,
    ),
    rfqDeliveryId: id,
  };
}
