import { recordServiceNotifications } from '../notification/notification.service.js';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation, nextVersion } from '../../utils/databaseMutation.js';
import {
  effectiveState,
  roleFor,
  requireEntitlement,
} from '../subscription/subscription.entitlements.js';
import type { Actor } from '../rfq/rfq.access.js';
import type {
  Prisma,
  ServiceTicket,
  ServiceTicketStatus,
} from '../../generated/client.js';
import type {
  TicketCreate,
  TicketQuery,
  TicketStatusInput,
} from './serviceTicket.validation.js';
export const serviceRoles = [
  'LOCAL_SUPPLIER',
  'INTERNATIONAL_MANUFACTURER',
  'INDEPENDENT_SELLER',
  'SALES_PERSON',
  'ADMIN',
] as const;
const admin = (a: Actor) => a.roles.includes('ADMIN');
const serviceActor = (a: Actor) =>
  a.roles.some((r) => serviceRoles.some((s) => s === r));
const reference = (sequence: number) =>
  `SVC-${String(sequence).padStart(6, '0')}`;
const pagination = (q: { page: number; limit: number }, total: number) => ({
  page: q.page,
  limit: q.limit,
  total,
  totalPages: Math.ceil(total / q.limit),
});
const page = (q: { page: number; limit: number }) => ({
  skip: (q.page - 1) * q.limit,
  take: q.limit,
});
const safeSelect = {
  id: true,
  sequence: true,
  subject: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  warrantyAssessment: true,
  machine: {
    select: {
      id: true,
      name: true,
      slug: true,
      model: true,
      manufacturer: true,
    },
  },
  customer: { select: { id: true, displayName: true } },
  assignedTo: { select: { id: true, displayName: true } },
} satisfies Prisma.ServiceTicketSelect;
async function readable(
  tx: Prisma.TransactionClient,
  id: string,
  a: Actor,
  lock = false,
) {
  if (lock)
    await tx.$queryRaw`SELECT id FROM service_tickets WHERE id=${id} FOR UPDATE`;
  const ticket = await tx.serviceTicket.findUnique({ where: { id } });
  if (
    !ticket ||
    !(
      admin(a) ||
      (a.roles.includes('BUYER') && ticket.customerId === a.id) ||
      (serviceActor(a) && ticket.assignedToId === a.id)
    )
  )
    throw new AppError('Service ticket not found', 404);
  return ticket;
}
const providerSelect = {
  id: true,
  status: true,
  isEmailVerified: true,
  displayName: true,
  assignedRole: { select: { role: true } },
  supplier: {
    select: {
      id: true,
      companyName: true,
      status: true,
      type: true,
      subscriptions: {
        where: { isCurrent: true },
        select: {
          state: true,
          startsAt: true,
          endsAt: true,
          supplierType: true,
        },
      },
    },
  },
} satisfies Prisma.UserSelect;
type Provider = Prisma.UserGetPayload<{ select: typeof providerSelect }>;
function providerReason(user: Provider | null) {
  if (
    !user ||
    user.status !== 'ACTIVE' ||
    !user.isEmailVerified ||
    !user.assignedRole.some((r) => serviceRoles.some((s) => s === r.role))
  )
    return 'An active service account is required';
  if (
    user.assignedRole.some(
      (r) => r.role === 'SALES_PERSON' || r.role === 'ADMIN',
    )
  )
    return '';
  const supplier = user.supplier;
  if (
    !supplier ||
    supplier.status !== 'APPROVED' ||
    !user.assignedRole.some((r) => r.role === roleFor(supplier.type))
  )
    return 'An approved supplier profile is required for service changes';
  const term = supplier.subscriptions[0];
  if (
    !term ||
    effectiveState(term) !== 'ACTIVE' ||
    term.supplierType !== supplier.type
  )
    return 'An applicable active supplier subscription is required';
  return '';
}
async function providerWritable(
  tx: Prisma.TransactionClient,
  userId: string,
  lock = true,
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: providerSelect,
  });
  const reason = providerReason(user);
  if (reason) throw new AppError(reason, 403);
  if (
    lock &&
    user?.supplier &&
    !user.assignedRole.some(
      (r) => r.role === 'SALES_PERSON' || r.role === 'ADMIN',
    )
  )
    await requireEntitlement(tx, user.supplier.id, { userId });
}
async function writable(
  tx: Prisma.TransactionClient,
  t: ServiceTicket,
  a: Actor,
  lock = true,
) {
  if (admin(a)) return;
  if (t.assignedToId !== a.id || !serviceActor(a))
    throw new AppError(
      'Only the assigned service party can perform this action',
      403,
    );
  await providerWritable(tx, a.id, lock);
}
function version(t: ServiceTicket, value: string) {
  if (t.updatedAt.getTime() !== new Date(value).getTime())
    throw new AppError('This ticket changed. Reload before saving', 409);
}
async function event(
  tx: Prisma.TransactionClient,
  t: ServiceTicket,
  a: Actor,
  type: string,
  input: {
    note?: string;
    visibility?: 'PUBLIC' | 'INTERNAL';
    toStatus?: ServiceTicketStatus;
    assignedToId?: string;
  } = {},
) {
  const created = await tx.serviceTicketEvent.create({
    data: {
      ticketId: t.id,
      actorId: a.id,
      type,
      visibility: input.visibility ?? 'PUBLIC',
      note: input.note,
      fromStatus: input.toStatus ? t.status : undefined,
      toStatus: input.toStatus,
      assignedToId: input.assignedToId,
    },
  });
  await recordServiceNotifications(tx, t, created);
  return created;
}
const mutation = <T>(
  id: string,
  a: Actor,
  expected: string,
  fn: (tx: Prisma.TransactionClient, t: ServiceTicket) => Promise<T>,
) =>
  databaseMutation(() =>
    prisma.$transaction(async (tx) => {
      const t = await readable(tx, id, a, true);
      version(t, expected);
      return fn(tx, t);
    }),
  );
const result = (t: { id: string; sequence: number }) => ({
  id: t.id,
  reference: reference(t.sequence),
});
const scope = (
  a: Actor,
  q: TicketQuery,
  all = false,
): Prisma.ServiceTicketWhereInput => {
  if (all && !admin(a)) throw new AppError('Administrator required', 403);
  if (!all && q.view === 'customer' && !a.roles.includes('BUYER'))
    throw new AppError('Buyer account required', 403);
  if (!all && q.view === 'assigned' && !serviceActor(a))
    throw new AppError('Service role required', 403);
  return {
    ...(all
      ? {}
      : q.view === 'customer'
        ? { customerId: a.id }
        : { assignedToId: a.id }),
    ...(q.status ? { status: q.status } : {}),
    ...(q.machineId ? { machineId: q.machineId } : {}),
    ...(all && q.customerId ? { customerId: q.customerId } : {}),
    ...(all && q.assignedToId ? { assignedToId: q.assignedToId } : {}),
    ...(q.q
      ? {
          OR: [
            { subject: { contains: q.q, mode: 'insensitive' } },
            { machine: { name: { contains: q.q, mode: 'insensitive' } } },
          ],
        }
      : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
  };
};
export const serviceTicketService = {
  async eligible(
    a: Actor,
    q: { page: number; limit: number; machine?: string; saleId?: string },
  ) {
    const where: Prisma.SaleRecordWhereInput = {
      status: 'COMPLETED',
      ...(q.saleId ? { id: q.saleId } : {}),
      opportunity: {
        recipient: {
          rfq: {
            buyerId: a.id,
            machineId: { not: null },
            ...(q.machine ? { machine: { slug: q.machine } } : {}),
          },
        },
      },
    };
    const [total, sales] = await prisma.$transaction(
      [
        prisma.saleRecord.count({ where }),
        prisma.saleRecord.findMany({
          where,
          ...page(q),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            completedAt: true,
            opportunity: {
              select: {
                recipient: {
                  select: {
                    rfq: {
                      select: {
                        machine: {
                          select: {
                            id: true,
                            name: true,
                            slug: true,
                            model: true,
                            manufacturer: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      purchases: sales.map((s) => ({
        saleId: s.id,
        completedAt: s.completedAt,
        machine: s.opportunity.recipient.rfq.machine,
      })),
      pagination: pagination({ page: q.page, limit: q.limit }, total),
    };
  },
  create(a: Actor, input: TicketCreate) {
    return databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${a.id + ':' + input.customerRequestId}))::text`;
        const existing = await tx.serviceTicket.findUnique({
          where: {
            customerId_customerRequestId: {
              customerId: a.id,
              customerRequestId: input.customerRequestId,
            },
          },
        });
        if (existing) {
          if (
            existing.saleId !== input.saleId ||
            existing.subject !== input.subject ||
            existing.description !== input.description ||
            (existing.warrantyAssessment !== 'NOT_REQUESTED') !==
              input.warrantyRequested
          )
            throw new AppError(
              'Submission reference already belongs to a different request',
              409,
            );
          return result(existing);
        }
        await tx.$queryRaw`SELECT id FROM sale_records WHERE id=${input.saleId} FOR UPDATE`;
        const sale = await tx.saleRecord.findUnique({
          where: { id: input.saleId },
          select: {
            status: true,
            opportunity: {
              select: {
                recipient: {
                  select: {
                    rfq: { select: { buyerId: true, machineId: true } },
                  },
                },
              },
            },
          },
        });
        if (
          !sale ||
          sale.status !== 'COMPLETED' ||
          sale.opportunity.recipient.rfq.buyerId !== a.id ||
          !sale.opportunity.recipient.rfq.machineId
        )
          throw new AppError(
            'Choose your completed purchase with an existing machinery record',
            422,
          );
        const ticket = await tx.serviceTicket.create({
          data: {
            customerId: a.id,
            machineId: sale.opportunity.recipient.rfq.machineId,
            saleId: input.saleId,
            customerRequestId: input.customerRequestId,
            subject: input.subject,
            description: input.description,
            warrantyAssessment: input.warrantyRequested
              ? 'PENDING'
              : 'NOT_REQUESTED',
          },
        });
        await event(tx, ticket, a, 'TICKET_CREATED', {
          note: input.warrantyRequested
            ? 'Service submitted with a warranty request'
            : 'Service request submitted',
        });
        return result(ticket);
      }),
    );
  },
  async list(a: Actor, q: TicketQuery, all = false) {
    const where = scope(a, q, all);
    const [total, tickets] = await prisma.$transaction(
      [
        prisma.serviceTicket.count({ where }),
        prisma.serviceTicket.findMany({
          where,
          ...page(q),
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          select: safeSelect,
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      tickets: tickets.map((t) => ({ ...t, reference: reference(t.sequence) })),
      pagination: pagination({ page: q.page, limit: q.limit }, total),
    };
  },
  async detail(a: Actor, id: string) {
    return prisma.$transaction(
      async (tx) => {
        const t = await readable(tx, id, a);
        let canWork = false,
          readOnlyReason = '';
        if (t.status !== 'CLOSED' && (admin(a) || t.assignedToId === a.id)) {
          try {
            await writable(tx, t, a, false);
            canWork = true;
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            readOnlyReason = error.message;
          }
        }
        const summaries = await tx.serviceTicket.findUniqueOrThrow({
          where: { id },
          select: safeSelect,
        });
        return {
          ...summaries,
          reference: reference(t.sequence),
          saleId: t.saleId,
          description: t.description,
          resolution: t.resolution,
          resolvedAt: t.resolvedAt,
          closedAt: t.closedAt,
          warrantyNote: t.warrantyNote,
          warrantyReviewedAt: t.warrantyReviewedAt,
          permissions: {
            canComment:
              t.status !== 'CLOSED' &&
              ((a.roles.includes('BUYER') && t.customerId === a.id) || canWork),
            canInternalNote: canWork,
            canReview: admin(a) && t.status === 'OPEN',
            canAssign:
              admin(a) &&
              ['UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status),
            canStart: canWork && t.status === 'ASSIGNED',
            canResolve: canWork && t.status === 'IN_PROGRESS',
            canClose:
              admin(a) &&
              t.status === 'RESOLVED' &&
              t.warrantyAssessment !== 'PENDING',
            canAssessWarranty:
              admin(a) &&
              t.status !== 'CLOSED' &&
              t.warrantyAssessment !== 'NOT_REQUESTED',
            readOnlyReason,
          },
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  },
  async events(a: Actor, id: string, q: { page: number; limit: number }) {
    return prisma.$transaction(
      async (tx) => {
        const t = await readable(tx, id, a);
        const internal =
          admin(a) || (serviceActor(a) && t.assignedToId === a.id);
        const where: Prisma.ServiceTicketEventWhereInput = {
          ticketId: id,
          ...(internal ? {} : { visibility: 'PUBLIC' }),
        };
        const total = await tx.serviceTicketEvent.count({ where });
        const events = await tx.serviceTicketEvent.findMany({
          where,
          ...page(q),
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            type: true,
            visibility: true,
            note: true,
            fromStatus: true,
            toStatus: true,
            createdAt: true,
            actor: { select: { displayName: true } },
            assignedTo: { select: { displayName: true } },
          },
        });
        return { events, pagination: pagination(q, total) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  },
  note(
    a: Actor,
    id: string,
    input: {
      updatedAt: string;
      note: string;
      visibility: 'PUBLIC' | 'INTERNAL';
    },
  ) {
    return mutation(id, a, input.updatedAt, async (tx, t) => {
      if (t.status === 'CLOSED')
        throw new AppError('Closed tickets are read-only', 409);
      const customer =
        a.roles.includes('BUYER') && t.customerId === a.id && !admin(a);
      if (customer && input.visibility === 'INTERNAL')
        throw new AppError('Customers cannot add internal notes', 403);
      if (!customer) await writable(tx, t, a);
      await tx.serviceTicket.update({
        where: { id },
        data: { updatedAt: nextVersion(input.updatedAt) },
      });
      await event(
        tx,
        t,
        a,
        customer ? 'CUSTOMER_COMMENT' : 'SERVICE_PROGRESS',
        { note: input.note, visibility: input.visibility },
      );
      return { id };
    });
  },
  status(a: Actor, id: string, input: TicketStatusInput) {
    return mutation(id, a, input.updatedAt, async (tx, t) => {
      const transitions: Partial<
        Record<ServiceTicketStatus, ServiceTicketStatus>
      > = {
        OPEN: 'UNDER_REVIEW',
        ASSIGNED: 'IN_PROGRESS',
        IN_PROGRESS: 'RESOLVED',
        RESOLVED: 'CLOSED',
      };
      if (transitions[t.status] !== input.status)
        throw new AppError('This status transition is not allowed', 409);
      if (['UNDER_REVIEW', 'CLOSED'].includes(input.status)) {
        if (!admin(a))
          throw new AppError(
            'Only administrators review or close tickets',
            403,
          );
      } else await writable(tx, t, a);
      if (input.status === 'CLOSED' && t.warrantyAssessment === 'PENDING')
        throw new AppError(
          'Assess the requested warranty before closing this ticket',
          409,
        );
      const now = new Date();
      await tx.serviceTicket.update({
        where: { id },
        data: {
          status: input.status,
          updatedAt: nextVersion(input.updatedAt),
          ...(input.status === 'RESOLVED'
            ? { resolution: input.resolution!, resolvedAt: now }
            : {}),
          ...(input.status === 'CLOSED' ? { closedAt: now } : {}),
        },
      });
      await event(tx, t, a, `TICKET_${input.status}`, {
        toStatus: input.status,
        note: input.status === 'RESOLVED' ? input.resolution : input.note,
      });
      return { id };
    });
  },
  async assignees(a: Actor, id: string) {
    if (!admin(a)) throw new AppError('Administrator required', 403);
    return prisma.$transaction(async (tx) => {
      const t = await readable(tx, id, a);
      const sale = await tx.saleRecord.findUniqueOrThrow({
        where: { id: t.saleId },
        select: {
          opportunity: {
            select: { recipient: { select: { recipientId: true } } },
          },
        },
      });
      const original = sale.opportunity.recipient.recipientId;
      const users = await tx.user.findMany({
        where: {
          id: { not: t.customerId },
          status: 'ACTIVE',
          isEmailVerified: true,
          OR: [
            {
              id: original,
              assignedRole: { some: { role: { in: [...serviceRoles] } } },
            },
            { assignedRole: { some: { role: 'SALES_PERSON' } } },
          ],
        },
        select: providerSelect,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: 100,
      });
      const candidates = users.map((user) => {
        const reason = providerReason(user);
        return {
          id: user.id,
          displayName: user.displayName,
          supplier: user.supplier
            ? { companyName: user.supplier.companyName }
            : null,
          eligible: !reason,
          reason,
        };
      });
      return { candidates };
    });
  },
  assign(
    a: Actor,
    id: string,
    input: { updatedAt: string; assignedToId: string },
  ) {
    if (!admin(a)) throw new AppError('Administrator required', 403);
    return mutation(id, a, input.updatedAt, async (tx, t) => {
      if (!['UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS'].includes(t.status))
        throw new AppError(
          'Review the ticket before assigning; resolved or closed tickets cannot be reassigned',
          409,
        );
      if (input.assignedToId === t.customerId)
        throw new AppError(
          'Customer cannot be assigned their own service ticket',
          422,
        );
      const sale = await tx.saleRecord.findUniqueOrThrow({
        where: { id: t.saleId },
        select: {
          opportunity: {
            select: { recipient: { select: { recipientId: true } } },
          },
        },
      });
      const user = await tx.user.findUnique({
        where: { id: input.assignedToId },
        select: { assignedRole: { select: { role: true } } },
      });
      if (
        !user ||
        (input.assignedToId !== sale.opportunity.recipient.recipientId &&
          !user.assignedRole.some((r) => r.role === 'SALES_PERSON'))
      )
        throw new AppError(
          'Choose the original sale recipient or an active iMet salesperson',
          422,
        );
      await providerWritable(tx, input.assignedToId);
      if (input.assignedToId === t.assignedToId)
        throw new AppError('This service party is already assigned', 409);
      const next = t.status === 'UNDER_REVIEW' ? 'ASSIGNED' : t.status;
      await tx.serviceTicket.update({
        where: { id },
        data: {
          assignedToId: input.assignedToId,
          status: next,
          updatedAt: nextVersion(input.updatedAt),
        },
      });
      await event(tx, t, a, 'TICKET_ASSIGNED', {
        assignedToId: input.assignedToId,
        toStatus: next,
      });
      return { id };
    });
  },
  warranty(
    a: Actor,
    id: string,
    input: {
      updatedAt: string;
      assessment: 'APPROVED' | 'DECLINED';
      note: string;
    },
  ) {
    if (!admin(a)) throw new AppError('Administrator required', 403);
    return mutation(id, a, input.updatedAt, async (tx, t) => {
      if (t.status === 'CLOSED' || t.warrantyAssessment === 'NOT_REQUESTED')
        throw new AppError(
          'Only open warranty requests accept an assessment',
          409,
        );
      await tx.serviceTicket.update({
        where: { id },
        data: {
          warrantyAssessment: input.assessment,
          warrantyNote: input.note,
          warrantyReviewedById: a.id,
          warrantyReviewedAt: new Date(),
          updatedAt: nextVersion(input.updatedAt),
        },
      });
      await event(tx, t, a, 'WARRANTY_ASSESSED', {
        note: `${input.assessment}: ${input.note}`,
      });
      return { id };
    });
  },
};
