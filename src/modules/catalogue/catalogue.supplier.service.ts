import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import { catalogueAdminService } from './catalogue.admin.service.js';
import type {
  MachineInput,
  AdminListQuery,
} from './catalogue.admin.validation.js';
async function owner(userId: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!supplier) throw new AppError('Supplier profile required', 403);
  return { supplierId: supplier.id, userId };
}
export const catalogueSupplierService = {
  async categories() {
    return prisma.machineCategory.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },
  async list(userId: string, query: AdminListQuery) {
    const scope = await owner(userId);
    const where = {
      supplierId: scope.supplierId,
      ...(query.q
        ? { name: { contains: query.q, mode: 'insensitive' as const } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    };
    const [total, machines] = await prisma.$transaction(
      [
        prisma.machine.count({ where }),
        prisma.machine.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
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
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  },
  async detail(userId: string, id: string) {
    const scope = await owner(userId);
    return catalogueAdminService.detail(id, scope.supplierId);
  },
  async create(userId: string, data: MachineInput) {
    return catalogueAdminService.create(data, await owner(userId));
  },
  async update(
    userId: string,
    id: string,
    data: MachineInput & { updatedAt: string },
  ) {
    return catalogueAdminService.update(id, data, await owner(userId));
  },
  async remove(userId: string, id: string, updatedAt: string) {
    return catalogueAdminService.remove(id, updatedAt, await owner(userId));
  },
};
