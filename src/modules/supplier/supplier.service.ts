import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { databaseMutation, nextVersion } from '../../utils/databaseMutation.js';
import {
  effectiveState,
  lockSupplier,
  publicSupplierWhere,
  roleFor,
} from '../subscription/subscription.entitlements.js';
import type { ProfileInput } from './supplier.validation.js';
const ownInclude = {
  subscriptions: { orderBy: { createdAt: 'desc' as const } },
};
const publicSelect = {
  id: true,
  companyName: true,
  type: true,
  description: true,
  city: true,
  country: true,
  website: true,
  logoUrl: true,
  isVerified: true,
  subscriptions: { where: { isCurrent: true }, select: { visibility: true } },
} satisfies Prisma.SupplierSelect;
export function supplierProjection<
  T extends {
    subscriptions: {
      state: 'ACTIVE' | 'PENDING' | 'SUSPENDED' | 'CANCELLED';
      startsAt: Date;
      endsAt: Date;
    }[];
  },
>(supplier: T) {
  return {
    ...supplier,
    subscriptions: supplier.subscriptions.map((term) => ({
      ...term,
      effectiveStatus: effectiveState(term),
    })),
  };
}
export const supplierService = {
  async own(userId: string) {
    const supplier = await prisma.supplier.findUnique({
      where: { userId },
      include: ownInclude,
    });
    return supplier ? supplierProjection(supplier) : null;
  },
  apply(userId: string, data: ProfileInput) {
    return databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.supplier.findUnique({ where: { userId } });
        if (existing) {
          const locked = await lockSupplier(tx, existing.id);
          if (locked.status !== 'REJECTED')
            throw new AppError(
              'You already have a supplier application or profile',
              409,
            );
          return tx.supplier.update({
            where: { id: existing.id },
            data: {
              ...data,
              status: 'PENDING',
              isVerified: false,
              marketplaceVisible: false,
              reviewNote: null,
            },
            include: ownInclude,
          });
        }
        return tx.supplier.create({
          data: { ...data, userId },
          include: ownInclude,
        });
      }),
    );
  },
  updateOwn(
    userId: string,
    data: Pick<
      ProfileInput,
      | 'description'
      | 'contactName'
      | 'businessEmail'
      | 'businessPhone'
      | 'website'
      | 'logoUrl'
    > & { updatedAt: string },
  ) {
    return databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const found = await tx.supplier.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!found) throw new AppError('Supplier not found', 404);
        const supplier = await lockSupplier(tx, found.id);
        if (supplier.status !== 'APPROVED')
          throw new AppError(
            'Only approved suppliers may edit this profile',
            403,
          );
        const { updatedAt, ...fields } = data;
        const result = await tx.supplier.updateMany({
          where: { id: supplier.id, updatedAt: new Date(updatedAt) },
          data: { ...fields, updatedAt: nextVersion(updatedAt) },
        });
        if (!result.count)
          throw new AppError('Profile changed. Reload before saving', 409);
        return tx.supplier.findUniqueOrThrow({
          where: { id: supplier.id },
          include: ownInclude,
        });
      }),
    );
  },
  async adminList(query: {
    q: string;
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'INACTIVE';
    page: number;
    limit: number;
  }) {
    const where: Prisma.SupplierWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? { companyName: { contains: query.q, mode: 'insensitive' } }
        : {}),
    };
    const [total, suppliers] = await prisma.$transaction(
      [
        prisma.supplier.count({ where }),
        prisma.supplier.findMany({
          where,
          include: ownInclude,
          orderBy: [{ companyName: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      suppliers: suppliers.map(supplierProjection),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },
  async adminDetail(id: string) {
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: ownInclude,
    });
    if (!supplier) throw new AppError('Supplier not found', 404);
    return supplierProjection(supplier);
  },
  review(
    id: string,
    data: {
      status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED' | 'INACTIVE';
      isVerified: boolean;
      marketplaceVisible: boolean;
      reviewNote: string | null;
      updatedAt: string;
    },
  ) {
    return databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const supplier = await lockSupplier(tx, id);
        const { updatedAt, ...fields } = data;
        if (supplier.updatedAt.toISOString() !== updatedAt)
          throw new AppError(
            'Application changed. Reload before reviewing',
            409,
          );
        if (data.status === 'APPROVED') {
          if (
            supplier.user.status !== 'ACTIVE' ||
            !supplier.user.isEmailVerified
          )
            throw new AppError(
              'Supplier account must be active and email verified',
              409,
            );
          await tx.userRoleAssignment.deleteMany({
            where: {
              userId: supplier.userId,
              role: { in: ['LOCAL_SUPPLIER', 'INTERNATIONAL_MANUFACTURER'] },
            },
          });
          await tx.userRoleAssignment.create({
            data: { userId: supplier.userId, role: roleFor(supplier.type) },
          });
        }
        return tx.supplier.update({
          where: { id },
          data: { ...fields, updatedAt: nextVersion(updatedAt) },
          include: ownInclude,
        });
      }),
    );
  },
  adminUpdate(id: string, data: ProfileInput & { updatedAt: string }) {
    return databaseMutation(() =>
      prisma.$transaction(async (tx) => {
        const supplier = await lockSupplier(tx, id);
        const { updatedAt, ...fields } = data;
        if (supplier.updatedAt.toISOString() !== updatedAt)
          throw new AppError('Profile changed. Reload before saving', 409);
        if (supplier.type !== data.type && supplier.status === 'APPROVED') {
          await tx.userRoleAssignment.deleteMany({
            where: {
              userId: supplier.userId,
              role: { in: ['LOCAL_SUPPLIER', 'INTERNATIONAL_MANUFACTURER'] },
            },
          });
          await tx.userRoleAssignment.create({
            data: { userId: supplier.userId, role: roleFor(data.type) },
          });
        }
        return tx.supplier.update({
          where: { id },
          data: {
            ...fields,
            isVerified: false,
            updatedAt: nextVersion(updatedAt),
          },
          include: ownInclude,
        });
      }),
    );
  },
  async publicList(query: { q: string; page: number; limit: number }) {
    const where: Prisma.SupplierWhereInput = {
      ...publicSupplierWhere(),
      ...(query.q
        ? { companyName: { contains: query.q, mode: 'insensitive' } }
        : {}),
    };
    const [total, suppliers] = await prisma.$transaction(
      [
        prisma.supplier.count({ where }),
        prisma.supplier.findMany({
          where,
          select: publicSelect,
          orderBy: [{ companyName: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      suppliers: suppliers.map(({ subscriptions, ...supplier }) => ({
        ...supplier,
        visibility: subscriptions[0]?.visibility,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },
  async publicDetail(id: string) {
    const supplier = await prisma.supplier.findFirst({
      where: { id, ...publicSupplierWhere() },
      select: publicSelect,
    });
    if (!supplier) throw new AppError('Supplier not found', 404);
    const { subscriptions, ...fields } = supplier;
    return { ...fields, visibility: subscriptions[0]?.visibility };
  },
};
