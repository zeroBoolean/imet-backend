import { recordAudit } from '../audit/audit.record.js';
import { prisma } from '../../config/database.js';
import { AppError } from '../../middleware/errorHandler.js';
import type { UserRole, UserStatus } from '../../generated/enums.js';
import { authService } from '../auth/auth.service.js';
export const userService = {
  async profile(id: string, displayName: string) {
    await prisma.user.update({ where: { id }, data: { displayName } });
    return authService.me(id);
  },
  async list(page: number, limit: number) {
    const [users, total] = await prisma.$transaction([
      prisma.user.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          email: true,
          displayName: true,
          status: true,
          isEmailVerified: true,
          assignedRole: { select: { role: true } },
        },
      }),
      prisma.user.count(),
    ]);
    return {
      users: users.map(({ assignedRole, ...user }) => ({
        ...user,
        roles: assignedRole.map((item) => item.role),
      })),
      page,
      limit,
      total,
    };
  },
  async update(
    actorId: string,
    id: string,
    data: { status?: UserStatus; roles?: UserRole[] },
  ) {
    if (actorId === id)
      throw new AppError(
        'Use another administrator to change your own access',
        403,
      );
    try {
      await prisma.$transaction(
        async (tx) => {
          const actor = await tx.user.findFirst({
            where: {
              id: actorId,
              status: 'ACTIVE',
              isEmailVerified: true,
              assignedRole: { some: { role: 'ADMIN' } },
            },
          });
          if (!actor) throw new AppError('Insufficient permissions', 403);
          const target = await tx.user.findUnique({
            where: { id },
            include: { assignedRole: true },
          });
          if (!target) throw new AppError('User not found', 404);
          if (data.status === 'ACTIVE' && !target.isEmailVerified)
            throw new AppError(
              'Email must be verified before activating an account',
              400,
            );
          const removingAdmin =
            target.assignedRole.some((item) => item.role === 'ADMIN') &&
            ((data.status && data.status !== 'ACTIVE') ||
              (data.roles && !data.roles.includes('ADMIN')));
          if (
            removingAdmin &&
            (await tx.user.count({
              where: {
                status: 'ACTIVE',
                isEmailVerified: true,
                assignedRole: { some: { role: 'ADMIN' } },
              },
            })) <= 1
          )
            throw new AppError(
              'At least one active administrator is required',
              409,
            );
          if (data.roles) {
            await tx.userRoleAssignment.deleteMany({ where: { userId: id } });
            await tx.userRoleAssignment.createMany({
              data: data.roles.map((role) => ({ userId: id, role })),
            });
          }
          if (data.status)
            await tx.user.update({
              where: { id },
              data: { status: data.status },
            });
          await tx.userSession.updateMany({
            where: { userId: id, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          await recordAudit(
            tx,
            actorId,
            'USER_ACCESS_UPDATED',
            'USER',
            id,
            Object.keys(data),
            {
              status: target.status,
              roles: target.assignedRole.map((item) => item.role),
            },
            {
              status: data.status ?? target.status,
              roles: data.roles ?? target.assignedRole.map((item) => item.role),
            },
          );
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2034'
      )
        throw new AppError('Account changed concurrently; try again', 409);
      throw error;
    }
    return authService.me(id);
  },
};
