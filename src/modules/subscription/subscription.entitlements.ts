import type { Prisma, SupplierSubscription } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
export function effectiveState(
  term: Pick<SupplierSubscription, 'state' | 'startsAt' | 'endsAt'>,
  now = new Date(),
) {
  if (term.state === 'CANCELLED' || term.state === 'SUSPENDED')
    return term.state;
  if (term.endsAt <= now) return 'EXPIRED';
  if (term.state === 'PENDING' || term.startsAt > now) return 'PENDING';
  return 'ACTIVE';
}
export const roleFor = (type: string) =>
  type === 'LOCAL'
    ? ('LOCAL_SUPPLIER' as const)
    : ('INTERNATIONAL_MANUFACTURER' as const);
export function publicSupplierWhere(
  now = new Date(),
): Prisma.SupplierWhereInput {
  const term = {
    isCurrent: true,
    state: 'ACTIVE' as const,
    startsAt: { lte: now },
    endsAt: { gt: now },
    visibility: { not: 'HIDDEN' as const },
  };
  return {
    status: 'APPROVED',
    marketplaceVisible: true,
    user: { status: 'ACTIVE', isEmailVerified: true },
    OR: [
      {
        type: 'LOCAL',
        user: { assignedRole: { some: { role: 'LOCAL_SUPPLIER' } } },
        subscriptions: { some: { ...term, supplierType: 'LOCAL' } },
      },
      {
        type: 'INTERNATIONAL',
        user: {
          assignedRole: { some: { role: 'INTERNATIONAL_MANUFACTURER' } },
        },
        subscriptions: { some: { ...term, supplierType: 'INTERNATIONAL' } },
      },
    ],
  };
}
export function publicMachineWhere(now = new Date()): Prisma.MachineWhereInput {
  const eligibleSupplier: Prisma.SupplierWhereInput = {
    ...publicSupplierWhere(now),
    subscriptions: {
      some: {
        isCurrent: true,
        state: 'ACTIVE',
        startsAt: { lte: now },
        endsAt: { gt: now },
        canPublishMachinery: true,
        visibility: { not: 'HIDDEN' },
      },
    },
  };
  return {
    status: 'PUBLISHED',
    OR: [{ supplierId: null }, { supplier: { is: eligibleSupplier } }],
  };
}
export async function lockSupplier(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id} FOR UPDATE`;
  const supplier = await tx.supplier.findUnique({
    where: { id },
    include: {
      user: {
        select: {
          status: true,
          isEmailVerified: true,
          assignedRole: { select: { role: true } },
        },
      },
      subscriptions: { where: { isCurrent: true } },
    },
  });
  if (!supplier) throw new AppError('Supplier not found', 404);
  return supplier;
}
export async function requireEntitlement(
  tx: Prisma.TransactionClient,
  supplierId: string,
  options: {
    userId?: string;
    publishing?: boolean;
    newListing?: boolean;
    images?: number;
    specifications?: number;
  },
) {
  const supplier = await lockSupplier(tx, supplierId);
  if (options.userId && supplier.userId !== options.userId)
    throw new AppError('Supplier not found', 404);
  if (
    supplier.status !== 'APPROVED' ||
    supplier.user.status !== 'ACTIVE' ||
    !supplier.user.isEmailVerified ||
    !supplier.user.assignedRole.some(
      (role) => role.role === roleFor(supplier.type),
    )
  )
    throw new AppError('An approved, active supplier account is required', 403);
  const term = supplier.subscriptions[0];
  if (
    !term ||
    effectiveState(term) !== 'ACTIVE' ||
    term.supplierType !== supplier.type
  )
    throw new AppError(
      'An applicable active supplier subscription is required',
      403,
    );
  if (
    options.publishing &&
    (!term.canPublishMachinery ||
      !supplier.marketplaceVisible ||
      term.visibility === 'HIDDEN')
  )
    throw new AppError(
      'Your subscription or marketplace settings do not permit publication',
      403,
    );
  if (options.images !== undefined && options.images > term.imageLimit)
    throw new AppError('Plan image limit exceeded', 403);
  if (
    options.specifications !== undefined &&
    options.specifications > term.specificationLimit
  )
    throw new AppError('Plan specification limit exceeded', 403);
  const count = await tx.machine.count({ where: { supplierId } });
  if (
    (options.newListing && count >= term.listingLimit) ||
    (options.publishing && count > term.listingLimit)
  )
    throw new AppError('Plan machinery listing limit exceeded', 403);
  return supplier;
}
