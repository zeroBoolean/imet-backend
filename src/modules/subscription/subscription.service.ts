import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation, nextVersion } from '../../utils/databaseMutation.js';
import { effectiveState, lockSupplier } from './subscription.entitlements.js';
import type { PlanInput } from './subscription.validation.js';
export const subscriptionService = {
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
  createPlan: (data: PlanInput) =>
    databaseMutation(() => prisma.subscriptionPlan.create({ data })),
  updatePlan: (id: string, data: PlanInput & { updatedAt: string }) =>
    databaseMutation(() =>
      prisma.$transaction(async (tx) => {
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
        return tx.subscriptionPlan.findUniqueOrThrow({ where: { id } });
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
        await tx.$queryRaw`SELECT id FROM subscription_plans WHERE id = ${data.planId} FOR UPDATE`;
        const plan = await tx.subscriptionPlan.findUnique({
          where: { id: data.planId },
        });
        if (
          !plan ||
          !plan.isActive ||
          !plan.eligibleTypes.includes(supplier.type)
        )
          throw new AppError(
            'Choose an active plan eligible for this supplier type',
            409,
          );
        const listings = await tx.machine.findMany({
          where: { supplierId },
          select: {
            _count: { select: { images: true, specifications: true } },
          },
        });
        if (
          listings.length > plan.listingLimit ||
          listings.some(
            (machine) =>
              machine._count.images > plan.imageLimit ||
              machine._count.specifications > plan.specificationLimit,
          )
        )
          throw new AppError(
            'Existing machinery exceeds this plan limits. Adjust listings or choose another plan',
            409,
          );
        await tx.supplierSubscription.updateMany({
          where: { supplierId, isCurrent: true },
          data: { isCurrent: false, state: 'CANCELLED' },
        });
        const term = await tx.supplierSubscription.create({
          data: {
            supplierId,
            planId: plan.id,
            state: data.state,
            startsAt: new Date(data.startsAt),
            endsAt: new Date(data.endsAt),
            planName: plan.name,
            supplierType: supplier.type,
            durationDays: plan.durationDays,
            price: plan.price,
            currency: plan.currency,
            listingLimit: plan.listingLimit,
            imageLimit: plan.imageLimit,
            specificationLimit: plan.specificationLimit,
            rfqEnabled: plan.rfqEnabled,
            leadLimitPerMonth: plan.leadLimitPerMonth,
            canRevealContacts: plan.canRevealContacts,
            canPublishMachinery: plan.canPublishMachinery,
            visibility: plan.visibility,
          },
        });
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
        return { ...term, effectiveStatus: effectiveState(term) };
      }),
    ),
};
