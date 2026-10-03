import { publicMachineWhere } from '../subscription/subscription.entitlements.js';
import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { CatalogueQuery } from './catalogue.validation.js';
// Explicit allowlist: future private supplier fields cannot leak through this API.
const publicSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  manufacturer: true,
  model: true,
  supplier: { select: { id: true, companyName: true, isVerified: true } },
  category: { select: { name: true, slug: true } },
  images: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { url: true, alt: true },
  },
} satisfies Prisma.MachineSelect;
export const catalogueService = {
  async categories() {
    return prisma.machineCategory.findMany({
      where: { machines: { some: publicMachineWhere() } },
      select: { name: true, slug: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  },
  async list({ q, category, supplier, page, limit }: CatalogueQuery) {
    const where: Prisma.MachineWhereInput = {
      ...publicMachineWhere(),
      ...(supplier ? { supplierId: supplier } : {}),
      ...(category ? { category: { slug: category } } : {}),
      ...(q
        ? {
            AND: [
              {
                OR: ['name', 'description', 'manufacturer', 'model'].map(
                  (field) => ({
                    [field]: { contains: q, mode: 'insensitive' },
                  }),
                ),
              },
            ],
          }
        : {}),
    };
    const [total, machines] = await prisma.$transaction(
      [
        prisma.machine.count({ where }),
        prisma.machine.findMany({
          where,
          select: {
            ...publicSelect,
            images: { ...publicSelect.images, take: 1 },
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
      ],
      { isolationLevel: 'RepeatableRead' },
    );
    return {
      machines,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },
  async detail(slug: string) {
    const machine = await prisma.machine.findFirst({
      where: { slug, ...publicMachineWhere() },
      select: {
        ...publicSelect,
        specifications: {
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { label: true, value: true },
        },
      },
    });
    if (!machine) throw new AppError('Machine not found', 404);
    return machine;
  },
};
