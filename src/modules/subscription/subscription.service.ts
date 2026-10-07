import { recordAudit } from '../audit/audit.record.js';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation, nextVersion } from '../../utils/databaseMutation.js';
import {
  effectiveState,
  lockSupplier,
  snapshot,
  eligiblePlan,
} from './subscription.entitlements.js';
import type { PlanInput } from './subscription.validation.js';
export const subscriptionService = {
  publicPlans: () =>
    prisma.subscriptionPlan.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        eligibleTypes: true,
        durationDays: true,
        price: true,
        currency: true,
        listingLimit: true,
        imageLimit: true,
        specificationLimit: true,
        canPublishMachinery: true,
        rfqEnabled: true,
        leadLimitPerMonth: true,
        canRevealContacts: true,
        visibility: true,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  plans: () =>
    prisma.subscriptionPlan.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  async availablePlans(userId: string) {
    const supplier = await prisma.supplier.findUnique({
      where: { userId },
      select: { type: true },
    });
    return prisma.subscriptionPlan.findMany({
      where: {
        isActive: true,
        ...(supplier ? { eligibleTypes: { has: supplier.type } } : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },
  createPlan: (data: PlanInput, actorId?: string) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const result = await tx.subscriptionPlan.create({ data });
        await recordAudit(
          tx,
          actorId,
          'SUBSCRIPTION_PLAN_CREATED',
          'SUBSCRIPTION_PLAN',
          result.id,
          Object.keys(data),
          {},
          result,
        );
        return result;
      }),
    ),
  updatePlan: (
    id: string,
    data: PlanInput & { updatedAt: string },
    actorId?: string,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const before = await tx.subscriptionPlan.findUnique({ where: { id } });
        const { updatedAt, ...fields } = data;
        const result = await tx.subscriptionPlan.updateMany({
          where: { id, updatedAt: new Date(updatedAt) },
          data: { ...fields, updatedAt: nextVersion(updatedAt) },
        });
        if (!result.count) {
          if (!(await tx.subscriptionPlan.findUnique({ where: { id } })))
            throw new AppError('Plan not found', 404);
          throw new AppError('Plan changed. Reload before saving', 409);
        }
        const resultPlan = await tx.subscriptionPlan.findUniqueOrThrow({
          where: { id },
        });
        await recordAudit(
          tx,
          actorId,
          'SUBSCRIPTION_PLAN_UPDATED',
          'SUBSCRIPTION_PLAN',
          id,
          Object.keys(data),
          before ?? {},
          resultPlan,
        );
        return resultPlan;
      }),
    ),
  assign: (
    supplierId: string,
    data: {
      planId: string;
      expectedCurrentId: string | null;
      expectedCurrentUpdatedAt: string | null;
      startsAt: string;
      endsAt: string;
      state: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
    },
    actorId?: string,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const supplier = await lockSupplier(tx, supplierId);
        const current = supplier.subscriptions[0];
        if (
          (current?.id ?? null) !== data.expectedCurrentId ||
          (current?.updatedAt.toISOString() ?? null) !==
            data.expectedCurrentUpdatedAt
        )
          throw new AppError(
            'Current subscription changed. Reload before assigning another term',
            409,
          );

        if (supplier.status !== 'APPROVED')
          throw new AppError(
            'Approve the supplier before assigning a subscription',
            409,
          );
        const plan = await eligiblePlan(
          tx,
          data.planId,
          supplierId,
          supplier.type,
        );
        await tx.supplierSubscription.updateMany({
          where: { supplierId, isCurrent: true },
          data: { isCurrent: false, state: 'CANCELLED' },
        });
        const term = await tx.supplierSubscription.create({
          data: {
            supplierId,
            ...snapshot(plan, supplier.type),
            state: data.state,
            startsAt: new Date(data.startsAt),
            endsAt: new Date(data.endsAt),
          },
        });
        await recordAudit(
          tx,
          actorId,
          'SUBSCRIPTION_ASSIGNED',
          'SUBSCRIPTION',
          term.id,
          ['planId', 'state', 'startsAt', 'endsAt'],
          {},
          term,
        );
        return { ...term, effectiveStatus: effectiveState(term) };
      }),
    ),
  update: (
    id: string,
    data: {
      startsAt: string;
      endsAt: string;
      state: 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
      updatedAt: string;
    },
    actorId?: string,
  ) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.supplierSubscription.findUnique({
          where: { id },
        });
        if (!existing) throw new AppError('Subscription not found', 404);
        await lockSupplier(tx, existing.supplierId);
        const { updatedAt, ...fields } = data;
        const result = await tx.supplierSubscription.updateMany({
          where: { id, isCurrent: true, updatedAt: new Date(updatedAt) },
          data: {
            ...fields,
            startsAt: new Date(data.startsAt),
            endsAt: new Date(data.endsAt),
            updatedAt: nextVersion(updatedAt),
          },
        });
        if (!result.count)
          throw new AppError(
            'Subscription changed or was replaced. Reload before saving',
            409,
          );
        const term = await tx.supplierSubscription.findUniqueOrThrow({
          where: { id },
        });
        await recordAudit(
          tx,
          actorId,
          'SUBSCRIPTION_UPDATED',
          'SUBSCRIPTION',
          id,
          Object.keys(data),
          existing,
          term,
        );
        return { ...term, effectiveStatus: effectiveState(term) };
      }),
    ),
};
