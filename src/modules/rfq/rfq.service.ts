import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation } from '../../utils/databaseMutation.js';
import { publicMachineWhere } from '../subscription/subscription.entitlements.js';
import { config } from '../../config/env.js';
import {
  rfqAccess,
  lockRfq,
  isAdmin,
  checkVersion,
  touch,
  type Actor,
} from './rfq.access.js';
import { rfqEvent, closeRfqLeads } from './rfqEvent.service.js';
import { routeRecipients } from './routing.service.js';
import { contactGate } from './contactGate.service.js';
import type { RfqInput, RfqQuery } from './rfq.validation.js';
export const attachmentSelect = {
  id: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  createdAt: true,
} satisfies Prisma.RfqAttachmentSelect;
export async function validateCatalogue(
  tx: Prisma.TransactionClient,
  input: RfqInput,
) {
  if (input.machineId) {
    const m = await tx.machine.findFirst({
      where: { id: input.machineId, ...publicMachineWhere() },
      select: { categoryId: true },
    });
    if (!m) throw new AppError('Choose an available published machine', 422);
    if (input.categoryId && input.categoryId !== m.categoryId)
      throw new AppError('Category does not match machinery', 422);
    return m.categoryId;
  }
  if (
    input.categoryId &&
    !(await tx.machineCategory.findUnique({ where: { id: input.categoryId } }))
  )
    throw new AppError('Category not found', 422);
  return input.categoryId;
}
export const rfqService = {
  resend: (a: Actor, id: string, version: string) =>
    prisma.$transaction(async (tx) => {
      const r = await lockRfq(tx, id);
      checkVersion(r.updatedAt, version);
      const leads = await tx.rfqRecipient.findMany({
        where: { rfqId: id, removedAt: null },
        select: { recipientId: true },
      });
      await rfqEvent(tx, id, a.id, 'NOTIFICATIONS_RESENT', {}, [
        r.buyerId,
        ...leads.map((l) => l.recipientId),
      ]);
    }),
  create: (a: Actor, input: RfqInput) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const categoryId = await validateCatalogue(tx, input);
        const [{ number }] = await tx.$queryRaw<
          { number: number }[]
        >`SELECT nextval('rfqs_sequence_seq')::int AS number`;
        const rfq = await tx.rfq.create({
          data: {
            ...input,
            categoryId,
            buyerId: a.id,
            sequence: number,
            rfqNumber: `RFQ-${new Date().getUTCFullYear()}-${String(number).padStart(6, '0')}`,
          },
        });
        await rfqEvent(tx, rfq.id, a.id, 'CREATED');
        return rfq;
      }),
    ),
  update: (a: Actor, id: string, data: RfqInput & { updatedAt: string }) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const r = await lockRfq(tx, id);
        if (r.buyerId !== a.id) throw new AppError('RFQ not found', 404);
        if (r.status !== 'DRAFT')
          throw new AppError('Only drafts can be edited', 409);
        checkVersion(r.updatedAt, data.updatedAt);
        const { updatedAt, ...input } = data;
        void updatedAt;
        const categoryId = await validateCatalogue(tx, input);
        const rfq = await tx.rfq.update({
          where: { id },
          data: { ...input, categoryId, updatedAt: touch(r.updatedAt) },
        });
        await rfqEvent(tx, id, a.id, 'DRAFT_UPDATED');
        return rfq;
      }),
    ),
  submit: (a: Actor, id: string, version: string) =>
    databaseMutation(() =>
      prisma.$transaction(
        async (tx) => {
          const r = await lockRfq(tx, id);
          if (r.buyerId !== a.id) throw new AppError('RFQ not found', 404);
          checkVersion(r.updatedAt, version);
          if (r.status !== 'DRAFT' || r.isFlagged)
            throw new AppError('Only unflagged drafts can be submitted', 409);
          if (
            r.machineId &&
            !(await tx.machine.findFirst({
              where: { id: r.machineId, ...publicMachineWhere() },
            }))
          )
            throw new AppError(
              'Selected machinery is no longer available',
              409,
            );
          const now = new Date();
          const submitted = await tx.rfq.update({
            where: { id },
            data: {
              status: 'SUBMITTED',
              submittedAt: now,
              expiresAt: new Date(
                now.getTime() + config.RFQ_EXPIRY_DAYS * 86400000,
              ),
              updatedAt: touch(r.updatedAt),
            },
          });
          await rfqEvent(tx, id, a.id, 'SUBMITTED', {}, [r.buyerId]);
          const routing = await routeRecipients(
            tx,
            submitted,
            undefined,
            'AUTO',
            a.id,
          );
          if (
            await tx.rfqRecipient.count({
              where: { rfqId: id, removedAt: null },
            })
          ) {
            await tx.rfq.update({
              where: { id },
              data: { status: 'ROUTED', updatedAt: touch(submitted.updatedAt) },
            });
            await rfqEvent(tx, id, null, 'ROUTED', {}, [r.buyerId]);
          } else await rfqEvent(tx, id, null, 'ROUTING_UNMATCHED');
          return {
            rfq: await tx.rfq.findUniqueOrThrow({ where: { id } }),
            routing,
          };
        },
        { timeout: 15000 },
      ),
    ),
  async list(
    a: Actor,
    q: RfqQuery,
    scope: 'buyer' | 'admin' | 'leads' = 'buyer',
  ) {
    const where: Prisma.RfqWhereInput = {
      ...(scope === 'buyer'
        ? { buyerId: a.id }
        : scope === 'leads'
          ? {
              recipients: {
                some: {
                  recipientId: a.id,
                  removedAt: null,
                  ...(q.leadStatus ? { leadStatus: q.leadStatus } : {}),
                },
              },
            }
          : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.q
        ? {
            OR: [
              { title: { contains: q.q, mode: 'insensitive' } },
              { rfqNumber: { contains: q.q, mode: 'insensitive' } },
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
      ...(scope === 'admin' && q.buyerId ? { buyerId: q.buyerId } : {}),
      ...(scope === 'admin' && q.recipientId
        ? {
            recipients: {
              some: { recipientId: q.recipientId, removedAt: null },
            },
          }
        : {}),
      ...(scope === 'admin' && (q.minValue || q.maxValue)
        ? {
            budgetCurrency: q.currency,
            targetBudget: {
              ...(q.minValue ? { gte: q.minValue } : {}),
              ...(q.maxValue ? { lte: q.maxValue } : {}),
            },
          }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.rfq.count({ where }),
      prisma.rfq.findMany({
        where,
        select: {
          id: true,
          rfqNumber: true,
          title: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          expiresAt: true,
          category: { select: { id: true, name: true } },
          ...(scope === 'leads'
            ? {
                recipients: {
                  where: { recipientId: a.id, removedAt: null },
                  select: { id: true, leadStatus: true },
                },
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      rfqs: rows,
      pagination: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.ceil(total / q.limit),
      },
    };
  },
  detail: (a: Actor, id: string) =>
    prisma.$transaction(async (tx) => {
      const r = await rfqAccess(tx, id, a);
      const owner = r.buyerId === a.id;
      const full = owner || isAdmin(a);
      const details = await tx.rfq.findUniqueOrThrow({
        where: { id },
        include: {
          machine: { select: { id: true, name: true, slug: true } },
          category: { select: { id: true, name: true } },
          attachments: { select: attachmentSelect },
          buyer: { select: { displayName: true, email: true } },
          recipients: {
            where: full ? {} : { recipientId: a.id, removedAt: null },
            include: {
              recipient: {
                select: {
                  displayName: true,
                  supplier: { select: { companyName: true, isVerified: true } },
                },
              },
              quotes: {
                include: { attachments: { select: attachmentSelect } },
                orderBy: { createdAt: 'desc' },
              },
            },
            orderBy: { routedAt: 'asc' },
          },
          events: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            ...(isAdmin(a)
              ? {}
              : { select: { id: true, eventType: true, createdAt: true } }),
          },
        },
      });
      const recipients = await Promise.all(
        details.recipients.map(async (lead) => {
          const contact = await contactGate(tx, id, lead.recipientId);
          return {
            id: lead.id,
            recipientId: lead.recipientId,
            recipientRole: lead.recipientRole,
            leadStatus: lead.leadStatus,
            routedAt: lead.routedAt,
            viewedAt: lead.viewedAt,
            respondedAt: lead.respondedAt,
            removedAt: lead.removedAt,
            name:
              lead.recipient.supplier?.companyName ??
              lead.recipient.displayName,
            isVerified: lead.recipient.supplier?.isVerified ?? false,
            contact: full ? contact : null,
            buyerContact:
              !full && contact ? { email: details.buyer.email } : null,
            quotes: lead.quotes,
          };
        }),
      );
      const {
        targetBudget,
        budgetCurrency,
        buyer,
        recipients: ignored,
        ...rest
      } = details;
      void ignored;
      return {
        ...rest,
        flagReason: isAdmin(a) ? r.flagReason : null,
        buyer: { displayName: buyer.displayName },
        ...(full ? { targetBudget, budgetCurrency } : {}),
        recipients,
      };
    }),
  end: (
    a: Actor,
    id: string,
    action: 'CANCELLED' | 'CLOSED',
    version: string,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const r = await lockRfq(tx, id);
        if (!isAdmin(a) && r.buyerId !== a.id)
          throw new AppError('RFQ not found', 404);
        checkVersion(r.updatedAt, version);
        if (['CLOSED', 'CANCELLED', 'EXPIRED', 'DECLINED'].includes(r.status))
          throw new AppError('RFQ is already final', 409);
        if (action === 'CANCELLED' && r.status === 'ACCEPTED')
          throw new AppError('Accepted RFQs must be closed', 409);
        if (action === 'CLOSED' && !isAdmin(a) && r.status !== 'ACCEPTED')
          throw new AppError('Accept a quote before closing', 409);
        const leads = await tx.rfqRecipient.findMany({
          where: { rfqId: id, removedAt: null },
          select: { recipientId: true },
        });
        const pending = await tx.rfqQuote.findMany({
          where: { rfqId: id, status: 'PENDING' },
          select: { id: true },
        });
        await tx.rfqQuote.updateMany({
          where: { rfqId: id, status: 'PENDING' },
          data: { status: 'WITHDRAWN' },
        });
        for (const q of pending)
          await rfqEvent(tx, id, a.id, 'QUOTE_WITHDRAWN', {
            quoteId: q.id,
            reason: action,
          });
        await closeRfqLeads(tx, id, a.id, 'RFQ_ENDED');
        const updated = await tx.rfq.update({
          where: { id },
          data: { status: action, updatedAt: touch(r.updatedAt) },
        });
        await rfqEvent(tx, id, a.id, action, {}, [
          r.buyerId,
          ...leads.map((l) => l.recipientId),
        ]);
        return updated;
      }),
    ),
  route: (
    a: Actor,
    id: string,
    version: string,
    userIds?: string[],
    remove = false,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(
        async (tx) => {
          const r = await lockRfq(tx, id);
          checkVersion(r.updatedAt, version);
          if (!isAdmin(a)) {
            if (
              !a.roles.includes('SALES_PERSON') ||
              !(await tx.rfqRecipient.findFirst({
                where: {
                  rfqId: id,
                  recipientId: a.id,
                  removedAt: null,
                  recipientRole: 'SALESPERSON',
                },
              }))
            )
              throw new AppError('RFQ not found', 404);
            if (remove)
              throw new AppError('Only admins may remove recipients', 403);
          }
          if (
            !['SUBMITTED', 'ROUTED', 'QUOTED', 'DECLINED'].includes(r.status) ||
            r.isFlagged ||
            !r.expiresAt ||
            r.expiresAt <= new Date()
          )
            throw new AppError(
              'RFQ cannot be routed in its current state',
              409,
            );
          if (remove) {
            const leads = await tx.rfqRecipient.findMany({
              where: {
                rfqId: id,
                recipientId: { in: userIds ?? [] },
                removedAt: null,
              },
            });
            for (const lead of leads) {
              const withdrawn = await tx.rfqQuote.findMany({
                where: { recipientId: lead.id, status: 'PENDING' },
                select: { id: true },
              });
              for (const q of withdrawn)
                await rfqEvent(tx, id, a.id, 'QUOTE_WITHDRAWN', {
                  quoteId: q.id,
                  reason: 'RECIPIENT_REMOVED',
                });
              await tx.rfqQuote.updateMany({
                where: { recipientId: lead.id, status: 'PENDING' },
                data: { status: 'WITHDRAWN' },
              });
              await tx.rfqRecipient.update({
                where: { id: lead.id },
                data: { removedAt: new Date(), leadStatus: 'CLOSED' },
              });
              await rfqEvent(
                tx,
                id,
                a.id,
                'RECIPIENT_REMOVED',
                { recipientId: lead.id },
                [lead.recipientId],
              );
            }
          } else
            await routeRecipients(
              tx,
              r,
              userIds,
              isAdmin(a) ? 'ADMIN_OVERRIDE' : 'MANUAL',
              a.id,
            );
          const pendingQuotes = await tx.rfqQuote.count({
            where: {
              rfqId: id,
              status: 'PENDING',
              recipient: { removedAt: null },
            },
          });
          const count = await tx.rfqRecipient.count({
            where: {
              rfqId: id,
              removedAt: null,
              leadStatus: { notIn: ['DECLINED', 'CLOSED'] },
            },
          });
          const assigned = await tx.rfqRecipient.count({
            where: { rfqId: id, removedAt: null },
          });
          const next = pendingQuotes
            ? 'QUOTED'
            : count
              ? 'ROUTED'
              : assigned
                ? 'DECLINED'
                : 'SUBMITTED';
          const updated = await tx.rfq.update({
            where: { id },
            data: { status: next, updatedAt: touch(r.updatedAt) },
          });
          await rfqEvent(tx, id, a.id, 'REROUTED', { status: next }, [
            r.buyerId,
          ]);
          return updated;
        },
        { timeout: 15000 },
      ),
    ),
  flag: (
    a: Actor,
    id: string,
    data: {
      isFlagged: boolean;
      reason: string;
      blockSupplierContact: boolean;
      updatedAt: string;
    },
  ) =>
    prisma.$transaction(async (tx) => {
      const r = await lockRfq(tx, id);
      checkVersion(r.updatedAt, data.updatedAt);
      if (data.blockSupplierContact) {
        const users = await tx.rfqRecipient.findMany({
          where: { rfqId: id },
          select: { recipientId: true },
        });
        await tx.supplier.updateMany({
          where: { userId: { in: users.map((u) => u.recipientId) } },
          data: { contactBlocked: data.isFlagged },
        });
      }
      await tx.rfq.update({
        where: { id },
        data: {
          isFlagged: data.isFlagged,
          flagReason: data.reason,
          updatedAt: touch(r.updatedAt),
        },
      });
      await rfqEvent(
        tx,
        id,
        a.id,
        data.isFlagged ? 'FLAGGED' : 'UNFLAGGED',
        {
          reason: data.reason,
          blockSupplierContact: data.blockSupplierContact,
        },
        [r.buyerId],
      );
    }),
};
