import {
  lockSupplier,
  requireEntitlement,
} from '../subscription/subscription.entitlements.js';
import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import type {
  AdminListQuery,
  CategoryInput,
  MachineInput,
} from './catalogue.admin.validation.js';
const include = {
  supplier: { select: { id: true, companyName: true } },
  category: { select: { id: true, name: true, slug: true } },
  images: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { url: true, alt: true },
  },
  specifications: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { label: true, value: true },
  },
} satisfies Prisma.MachineInclude;
async function mutation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'P2002')
        throw new AppError('This slug is already in use', 409);
      if (error.code === 'P2003')
        throw new AppError('Category is in use or no longer available', 409);
      if (error.code === 'P2025')
        throw new AppError('Catalogue record not found', 404);
    }
    throw error;
  }
}
function children(data: MachineInput) {
  return {
    images: {
      create: data.images.map((image, position) => ({ ...image, position })),
    },
    specifications: {
      create: data.specifications.map((specification, position) => ({
        ...specification,
        position,
      })),
    },
  };
}
function fields(data: MachineInput & { supplierId?: string | null }) {
  return {
    ...(data.supplierId !== undefined ? { supplierId: data.supplierId } : {}),
    name: data.name,
    slug: data.slug,
    description: data.description,
    manufacturer: data.manufacturer,
    model: data.model,
    categoryId: data.categoryId,
    status: data.status,
  };
}
export const catalogueAdminService = {
  categories: () =>
    prisma.machineCategory.findMany({
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { machines: true } } },
    }),
  createCategory: (data: CategoryInput) =>
    mutation(() => prisma.machineCategory.create({ data })),
  updateCategory: (id: string, data: CategoryInput) =>
    mutation(() => prisma.machineCategory.update({ where: { id }, data })),
  deleteCategory: (id: string) =>
    mutation(() => prisma.machineCategory.delete({ where: { id } })),
  async list({ q, categoryId, status, page, limit }: AdminListQuery) {
    const where: Prisma.MachineWhereInput = {
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: ['name', 'manufacturer', 'model', 'slug'].map((field) => ({
              [field]: { contains: q, mode: 'insensitive' },
            })),
          }
        : {}),
    };
    const [total, machines] = await prisma.$transaction(
      [
        prisma.machine.count({ where }),
        prisma.machine.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            updatedAt: true,
            category: { select: { name: true } },
          },
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      machines,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },
  async detail(id: string, supplierId?: string) {
    const machine = await prisma.machine.findUnique({
      where: { id, ...(supplierId ? { supplierId } : {}) },
      include,
    });
    if (!machine) throw new AppError('Machine not found', 404);
    return machine;
  },
  create(
    data: MachineInput & { supplierId?: string | null },
    owner?: { supplierId: string; userId: string },
  ) {
    const supplierId = owner?.supplierId ?? data.supplierId;
    return mutation(() =>
      prisma.$transaction(async (tx) => {
        if (supplierId)
          await requireEntitlement(tx, supplierId, {
            userId: owner?.userId,
            newListing: true,
            publishing: data.status === 'PUBLISHED',
            images: data.images.length,
            specifications: data.specifications.length,
          });
        return tx.machine.create({
          data: {
            ...fields(data),
            supplierId: supplierId ?? null,
            ...children(data),
          },
          include,
        });
      }),
    );
  },
  update(
    id: string,
    data: MachineInput & { updatedAt: string; supplierId?: string | null },
    owner?: { supplierId: string; userId: string },
  ) {
    const { updatedAt } = data;
    const nextVersion = new Date(
      Math.max(Date.now(), new Date(updatedAt).getTime() + 1),
    );
    return mutation(() =>
      prisma.$transaction(async (tx) => {
        const current = await tx.machine.findUnique({
          where: { id },
          select: { supplierId: true },
        });
        if (!current || (owner && current.supplierId !== owner.supplierId))
          throw new AppError('Machine not found', 404);
        const target =
          owner?.supplierId ??
          (data.supplierId === undefined
            ? current.supplierId
            : data.supplierId);
        for (const supplierId of [
          ...new Set(
            [current.supplierId, target].filter((id): id is string => !!id),
          ),
        ].sort())
          await lockSupplier(tx, supplierId);
        if (
          target &&
          (owner ||
            data.status === 'PUBLISHED' ||
            target !== current.supplierId)
        )
          await requireEntitlement(tx, target, {
            userId: owner?.userId,
            newListing: target !== current.supplierId,
            publishing: data.status === 'PUBLISHED',
            images: data.images.length,
            specifications: data.specifications.length,
          });
        const changed = await tx.machine.updateMany({
          where: { id, updatedAt: new Date(updatedAt) },
          data: { ...fields(data), updatedAt: nextVersion },
        });
        if (!changed.count) {
          if (
            !(await tx.machine.findUnique({
              where: { id },
              select: { id: true },
            }))
          )
            throw new AppError('Machine not found', 404);
          throw new AppError(
            'This machine changed. Reload it before saving',
            409,
          );
        }
        await tx.machineImage.deleteMany({ where: { machineId: id } });
        await tx.machineSpecification.deleteMany({ where: { machineId: id } });
        return tx.machine.update({
          where: { id },
          data: { ...children(data), updatedAt: nextVersion },
          include,
        });
      }),
    );
  },
  remove(
    id: string,
    updatedAt: string,
    owner?: { supplierId: string; userId: string },
  ) {
    return mutation(() =>
      prisma.$transaction(async (tx) => {
        const current = await tx.machine.findUnique({
          where: { id },
          select: { supplierId: true },
        });
        if (!current || (owner && current.supplierId !== owner.supplierId))
          throw new AppError('Machine not found', 404);
        if (current.supplierId) {
          if (owner)
            await requireEntitlement(tx, current.supplierId, {
              userId: owner.userId,
            });
          else await lockSupplier(tx, current.supplierId);
        }
        if (await tx.machineMedia.count({ where: { machineId: id } }))
          throw new AppError(
            'Remove advanced media before deleting this machine',
            409,
          );
        const deleted = await tx.machine.deleteMany({
          where: { id, updatedAt: new Date(updatedAt) },
        });
        if (!deleted.count) {
          if (
            !(await tx.machine.findUnique({
              where: { id },
              select: { id: true },
            }))
          )
            throw new AppError('Machine not found', 404);
          throw new AppError(
            'This machine changed. Reload it before deleting',
            409,
          );
        }
        return { id };
      }),
    );
  },
};
