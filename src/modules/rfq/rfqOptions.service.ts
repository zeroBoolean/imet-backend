import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { Actor } from './rfq.access.js';
export const rfqOptionsService = {
  categories: () =>
    prisma.machineCategory.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
      take: 500,
    }),
  async recipients(a: Actor, q: string, buyers = false) {
    if (buyers && !a.roles.includes('ADMIN'))
      throw new AppError('Insufficient permissions', 403);
    return prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        isEmailVerified: true,
        assignedRole: {
          some: {
            role: {
              in: buyers
                ? ['BUYER']
                : [
                    'LOCAL_SUPPLIER',
                    'INTERNATIONAL_MANUFACTURER',
                    'INDEPENDENT_SELLER',
                    'SALES_PERSON',
                  ],
            },
          },
        },
        ...(q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                {
                  supplier: {
                    companyName: { contains: q, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        displayName: true,
        assignedRole: { select: { role: true } },
        supplier: { select: { companyName: true } },
      },
      orderBy: { id: 'asc' },
      take: 100,
    });
  },
};
