import type {
  Prisma,
  AuditResourceType,
  UserRole,
  UserStatus,
  MachineStatus,
  SupplierStatus,
  SupplierType,
  ReviewStatus,
  SubscriptionState,
} from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
export type AuditAction =
  | 'USER_ACCESS_UPDATED'
  | 'CATEGORY_CREATED'
  | 'CATEGORY_UPDATED'
  | 'CATEGORY_DELETED'
  | 'MACHINERY_CREATED'
  | 'MACHINERY_UPDATED'
  | 'MACHINERY_DELETED'
  | 'SUPPLIER_ADMIN_UPDATED'
  | 'SUBSCRIPTION_PLAN_CREATED'
  | 'SUBSCRIPTION_PLAN_UPDATED'
  | 'SUBSCRIPTION_ASSIGNED'
  | 'SUBSCRIPTION_UPDATED'
  | 'REVIEW_MODERATED'
  | 'SUPPLIER_MANUAL_ACTIVATION';
type StateInput = {
  status?: UserStatus | MachineStatus | SupplierStatus | ReviewStatus;
  state?: SubscriptionState;
  type?: SupplierType;
  roles?: UserRole[];
  isVerified?: boolean;
  marketplaceVisible?: boolean;
  isActive?: boolean;
  startsAt?: Date;
  endsAt?: Date;
};
export function safeState(value: StateInput) {
  return {
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.state !== undefined ? { state: value.state } : {}),
    ...(value.type !== undefined ? { type: value.type } : {}),
    ...(value.roles ? { roles: [...value.roles].sort() } : {}),
    ...(value.isVerified !== undefined ? { isVerified: value.isVerified } : {}),
    ...(value.marketplaceVisible !== undefined
      ? { marketplaceVisible: value.marketplaceVisible }
      : {}),
    ...(value.isActive !== undefined ? { isActive: value.isActive } : {}),
    ...(value.startsAt ? { startsAt: value.startsAt.toISOString() } : {}),
    ...(value.endsAt ? { endsAt: value.endsAt.toISOString() } : {}),
  };
}
export async function recordAudit(
  tx: Prisma.TransactionClient,
  actorId: string | undefined,
  action: AuditAction,
  resourceType: AuditResourceType,
  resourceId: string,
  changedFields: string[],
  before: StateInput = {},
  after: StateInput = {},
  activation?: {
    activationMethod: string;
    activationReason: string;
    targetUserId: string;
  },
) {
  if (!actorId) throw new AppError('Audit actor is required', 403);
  if (
    !(await tx.user.findFirst({
      where: {
        id: actorId,
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: { some: { role: 'ADMIN' } },
      },
      select: { id: true },
    }))
  )
    throw new AppError('Administrator required', 403);
  return tx.auditLog.create({
    data: {
      actorId,
      action,
      resourceType,
      resourceId,
      context: {
        changedFields: [
          ...new Set(changedFields.filter((f) => f !== 'updatedAt')),
        ].sort(),
        ...(activation ?? {}),
        before: safeState(before),
        after: safeState(after),
      },
    },
  });
}
