import type { RequestHandler } from 'express';
import { prisma } from '../config/database.js';
import { AppError } from './errorHandler.js';
import { verifyAccessToken } from '../utils/jwt.js';
import type { UserRole } from '../generated/enums.js';
export const authenticate =
  (roles: UserRole[] = [], allowPending = false): RequestHandler =>
  async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer '))
        throw new AppError('Authentication required', 401);
      const claims = verifyAccessToken(header.slice(7));
      const session = await prisma.userSession.findUnique({
        where: { id: claims.sessionId },
        include: { user: { include: { assignedRole: true } } },
      });
      if (
        !session ||
        session.userId !== claims.userId ||
        session.revokedAt ||
        session.expiresAt <= new Date()
      )
        throw new AppError('Invalid or expired session', 401);
      if (
        (session.user.status !== 'ACTIVE' &&
          !(allowPending && session.user.status === 'PENDING')) ||
        !session.user.isEmailVerified
      )
        throw new AppError('Account is not active', 403);
      const assignedRoles = session.user.assignedRole.map((item) => item.role);
      if (roles.length && !roles.some((role) => assignedRoles.includes(role)))
        throw new AppError('Insufficient permissions', 403);
      res.locals.auth = {
        id: session.userId,
        sessionId: session.id,
        roles: assignedRoles,
      };
      next();
    } catch (error) {
      next(error);
    }
  };
