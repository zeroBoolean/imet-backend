import { snapshot } from '../subscription/subscription.entitlements.js';
import type { ProfileInput } from '../supplier/supplier.validation.js';
import { roleFor } from '../subscription/subscription.entitlements.js';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { hashPassword, verifyPassword } from '../../utils/hashing.js';
import { newToken, tokenHash, expiresIn } from '../../utils/tokens.js';
import { signAccessToken } from '../../utils/jwt.js';
import {
  encrypt,
  decrypt,
  recordAuthEmail,
  dispatchAuthEmails,
} from '../../emails/authIntents.js';
import { verifyGoogleIdentity } from './google.js';
import type { Prisma } from '../../generated/client.js';
const publicSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  isEmailVerified: true,
  assignedRole: { select: { role: true } },
} satisfies Prisma.UserSelect;
let dummyPasswordHash: Promise<string> | undefined;
export const authService = {
  async register(
    data: {
      email: string;
      password: string;
      displayName: string;
    },
    supplier?: { profile: ProfileInput; planId: string },
  ) {
    if (!config.PUBLIC_SIGNUP_ROLE)
      throw new AppError(
        'Account registration is currently unavailable. Please try again later.',
        503,
      );
    const signupRole = supplier
      ? roleFor(supplier.profile.type)
      : config.PUBLIC_SIGNUP_ROLE;
    if (supplier) {
      const plan = await prisma.subscriptionPlan.findFirst({
        where: {
          id: supplier.planId,
          isActive: true,
          eligibleTypes: { has: supplier.profile.type },
        },
      });
      if (!plan)
        throw new AppError('Choose an active, eligible subscription plan', 400);
      if (
        supplier.profile.logoAssetId ||
        supplier.profile.logoUrl?.startsWith('/') ||
        supplier.profile.documents.some((d) => d.assetId)
      )
        throw new AppError(
          'Upload company files after verifying your account',
          400,
        );
    }
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existing) {
      await dispatchAuthEmails(existing.id);
      return;
    }
    const password = await hashPassword(data.password);
    const token = newToken();
    const expiry = expiresIn(60);
    let userId: string | undefined;
    try {
      userId = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            ...data,
            password,
            ...(supplier
              ? {
                  status: 'PENDING' as const,
                  supplier: {
                    create: {
                      ...supplier.profile,
                      logoAssetId: undefined,
                      documents: supplier.profile.documents,
                    },
                  },
                }
              : {}),
            emailVerificationTokenHash: token.hash,
            emailVerificationExpires: expiry,
            assignedRole: { create: { role: signupRole } },
          },
        });
        if (supplier) {
          await tx.$queryRaw`SELECT id FROM subscription_plans WHERE id = ${supplier.planId} FOR UPDATE`;
          const selected = await tx.subscriptionPlan.findUnique({
            where: { id: supplier.planId },
          });
          if (
            !selected ||
            !selected.isActive ||
            !selected.eligibleTypes.includes(supplier.profile.type)
          )
            throw new AppError('Selected plan is no longer available', 409);
          const company = await tx.supplier.findUniqueOrThrow({
            where: { userId: user.id },
          });
          const now = new Date();
          await tx.supplierSubscription.create({
            data: {
              supplierId: company.id,
              ...snapshot(selected, company.type),
              state: 'PENDING',
              startsAt: now,
              endsAt: new Date(
                now.getTime() + selected.durationDays * 86400000,
              ),
            },
          });
        }
        await recordAuthEmail(tx, user.id, 'verify-user', token, expiry);
        return user.id;
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error &&
        'code' in error &&
        error.code === 'P2002'
      )
        return;
      throw error;
    }
    await dispatchAuthEmails(userId);
  },
  async google(idToken: string, linkUserId?: string) {
    const identity = await verifyGoogleIdentity(idToken);
    const password = await hashPassword(newToken().raw);
    const token = newToken();
    const session = await prisma.$transaction(async (tx) => {
      // Account creation/linking is serialized across workers for a Google identity/email.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${identity.email}))`;
      let user = await tx.user.findUnique({
        where: { googleSubject: identity.subject },
      });
      if (!user) {
        user = await tx.user.findUnique({ where: { email: identity.email } });
        if (user && user.id !== linkUserId)
          throw new AppError(
            'Sign in with your password, then link Google from your account settings.',
            409,
          );
        if (linkUserId && (!user || user.id !== linkUserId))
          throw new AppError(
            'Google email must match your verified iMet account.',
            403,
          );
        if (user) {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
          user = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
          if (
            user.status !== 'ACTIVE' ||
            !user.isEmailVerified ||
            user.googleSubject
          )
            throw new AppError('Account cannot be linked', 403);
          user = await tx.user.update({
            where: { id: user.id },
            data: { googleSubject: identity.subject },
          });
        } else {
          if (!config.PUBLIC_SIGNUP_ROLE)
            throw new AppError(
              'Account registration is currently unavailable',
              503,
            );
          user = await tx.user.create({
            data: {
              email: identity.email,
              displayName: identity.displayName,
              password,
              googleSubject: identity.subject,
              status: 'ACTIVE',
              isEmailVerified: true,
              assignedRole: { create: { role: config.PUBLIC_SIGNUP_ROLE } },
            },
          });
        }
      }
      if (linkUserId && user.id !== linkUserId)
        throw new AppError(
          'Google account is already linked to another account',
          409,
        );
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      user = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (user.status !== 'ACTIVE' || !user.isEmailVerified)
        throw new AppError('Account is not active', 403);
      return tx.userSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: token.hash,
          expiresAt: expiresIn(7 * 24 * 60),
        },
      });
    });
    return {
      user: await this.me(session.userId),
      accessToken: signAccessToken(session.userId, session.id),
      refreshToken: token.raw,
      expiresAt: Date.now() + 15 * 60000,
    };
  },
  async revokeLinkedSession(raw: string) {
    await prisma.userSession.updateMany({
      where: { refreshTokenHash: tokenHash(raw) },
      data: { revokedAt: new Date() },
    });
  },
  async verify(token: string) {
    const verified = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { emailVerificationTokenHash: tokenHash(token) },
      });
      if (!user) return false;
      const result = await tx.user.updateMany({
        where: {
          id: user.id,
          emailVerificationTokenHash: tokenHash(token),
          emailVerificationExpires: { gt: new Date() },
          status: { in: ['PENDING_VERIFICATION', 'PENDING'] },
          isEmailVerified: false,
        },
        data: {
          isEmailVerified: true,
          status: user.status === 'PENDING' ? 'PENDING' : 'ACTIVE',
          emailVerificationTokenHash: null,
          emailVerificationExpires: null,
        },
      });
      return !!result.count;
    });
    if (!verified)
      throw new AppError('Invalid or expired verification link', 400);
  },
  async login(email: string, password: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    const candidateHash =
      user?.password ??
      (await (dummyPasswordHash ??= hashPassword(
        'DummyComparisonPassword123!',
      )));
    const validPassword = await verifyPassword(candidateHash, password);
    if (!user || !validPassword)
      throw new AppError('Invalid email or password', 401);
    if (!user.isEmailVerified)
      throw new AppError('Verify your email before signing in', 403);
    if (!['ACTIVE', 'PENDING'].includes(user.status))
      throw new AppError('Account is not active', 403);
    const token = newToken();
    const session = await prisma.$transaction(async (tx) => {
      // Serialize session issuance with password/status changes on this account.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.password !== user.password)
        throw new AppError('Invalid email or password', 401);
      if (
        !['ACTIVE', 'PENDING'].includes(current.status) ||
        !current.isEmailVerified
      )
        throw new AppError('Account is not active', 403);
      return tx.userSession.create({
        data: {
          userId: user.id,
          refreshTokenHash: token.hash,
          expiresAt: expiresIn(7 * 24 * 60),
        },
      });
    });
    return {
      user: await this.me(user.id),
      accessToken: signAccessToken(user.id, session.id),
      refreshToken: token.raw,
      expiresAt: Date.now() + 15 * 60_000,
    };
  },
  async me(id: string) {
    const user = await prisma.user.findUnique({
      where: { id },
      select: publicSelect,
    });
    if (!user) throw new AppError('User not found', 404);
    const { assignedRole, ...rest } = user;
    return { ...rest, roles: assignedRole.map((item) => item.role) };
  },
  async resend(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (
      !user ||
      !['PENDING_VERIFICATION', 'PENDING'].includes(user.status) ||
      user.isEmailVerified
    )
      return;
    const token = newToken();
    const expiry = expiresIn(60);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const changed = await tx.user.updateMany({
        where: {
          id: user.id,
          status: { in: ['PENDING_VERIFICATION', 'PENDING'] },
          isEmailVerified: false,
        },
        data: {
          emailVerificationTokenHash: token.hash,
          emailVerificationExpires: expiry,
        },
      });
      if (changed.count)
        await recordAuthEmail(tx, user.id, 'verify-user', token, expiry);
    });
    await dispatchAuthEmails(user.id);
  },
  async forgot(email: string) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (
      !user ||
      !['ACTIVE', 'PENDING'].includes(user.status) ||
      !user.isEmailVerified
    )
      return;
    const token = newToken();
    const expiry = expiresIn(60);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const changed = await tx.user.updateMany({
        where: {
          id: user.id,
          status: { in: ['ACTIVE', 'PENDING'] },
          isEmailVerified: true,
        },
        data: {
          passwordResetTokenHash: token.hash,
          passwordResetExpires: expiry,
        },
      });
      if (changed.count)
        await recordAuthEmail(tx, user.id, 'reset-password', token, expiry);
    });
    await dispatchAuthEmails(user.id);
  },
  async reset(token: string, password: string) {
    const hash = tokenHash(token);
    const user = await prisma.user.findUnique({
      where: { passwordResetTokenHash: hash },
    });
    if (!user || !['ACTIVE', 'PENDING'].includes(user.status))
      throw new AppError('Invalid or expired reset link', 400);
    const hashedPassword = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordResetTokenHash: hash,
          passwordResetExpires: { gt: new Date() },
          status: { in: ['ACTIVE', 'PENDING'] },
        },
        data: {
          password: hashedPassword,
          passwordResetTokenHash: null,
          passwordResetExpires: null,
        },
      });
      if (!changed.count)
        throw new AppError('Invalid or expired reset link', 400);
      await tx.userSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  },
  async changePassword(id: string, current: string, password: string) {
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user || !(await verifyPassword(user.password, current)))
      throw new AppError('Current password is incorrect', 400);
    const hashedPassword = await hashPassword(password);
    await prisma.$transaction(async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id, password: user.password, status: 'ACTIVE' },
        data: {
          password: hashedPassword,
          passwordResetTokenHash: null,
          passwordResetExpires: null,
        },
      });
      if (!changed.count)
        throw new AppError('Account changed; sign in again', 409);
      await tx.userSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  },
  async refresh(raw: string, coordinated = false) {
    const oldHash = tokenHash(raw),
      next = newToken();
    const result = await prisma.$transaction(async (tx) => {
      if (coordinated) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${oldHash}))`;
        const cached = await tx.authRefreshHandoff.findUnique({
          where: { tokenHash: oldHash },
          include: { session: { include: { user: true } } },
        });
        if (
          cached &&
          cached.expiresAt > new Date() &&
          !cached.session.revokedAt &&
          cached.session.expiresAt > new Date() &&
          ['ACTIVE', 'PENDING'].includes(cached.session.user.status) &&
          cached.session.user.isEmailVerified
        ) {
          const auth = JSON.parse(decrypt(cached.encryptedResult)) as {
            user: Awaited<ReturnType<typeof authService.me>>;
            accessToken: string;
            refreshToken: string;
            expiresAt: number;
          };
          if (tokenHash(auth.refreshToken) === cached.session.refreshTokenHash)
            return auth;
        }
      }
      const old = await tx.userSession.findUnique({
        where: { refreshTokenHash: oldHash },
        include: { user: true },
      });
      if (
        !old ||
        old.revokedAt ||
        old.expiresAt <= new Date() ||
        !['ACTIVE', 'PENDING'].includes(old.user.status) ||
        !old.user.isEmailVerified
      )
        throw new AppError('Invalid or expired session', 401);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${old.userId} FOR UPDATE`;
      const user = await tx.user.findUnique({
        where: { id: old.userId },
        select: publicSelect,
      });
      if (
        !user ||
        !['ACTIVE', 'PENDING'].includes(user.status) ||
        !user.isEmailVerified
      )
        throw new AppError('Invalid or expired session', 401);
      const changed = await tx.userSession.updateMany({
        where: {
          id: old.id,
          refreshTokenHash: oldHash,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { refreshTokenHash: next.hash },
      });
      if (!changed.count) throw new AppError('Invalid or expired session', 401);
      const { assignedRole, ...publicUser } = user;
      const auth = {
        user: { ...publicUser, roles: assignedRole.map((item) => item.role) },
        accessToken: signAccessToken(old.userId, old.id),
        refreshToken: next.raw,
        expiresAt: Date.now() + 15 * 60000,
      };
      if (coordinated)
        await tx.authRefreshHandoff.create({
          data: {
            tokenHash: oldHash,
            sessionId: old.id,
            encryptedResult: encrypt(JSON.stringify(auth)),
            expiresAt: new Date(Date.now() + 5000),
          },
        });
      return auth;
    });
    if (coordinated)
      await prisma.authRefreshHandoff.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });
    return result;
  },
  async logout(userId: string, sessionId: string, all = false) {
    await prisma.userSession.updateMany({
      where: { userId, ...(all ? {} : { id: sessionId }), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  },
};
