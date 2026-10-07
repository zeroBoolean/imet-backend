import { bindSupplierAssets } from '../supplier/supplier.assets.service.js';
import type { ProfileInput } from '../supplier/supplier.validation.js';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import { Prisma, type SupplierType } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import {
  lockSupplier,
  effectiveState,
  roleFor,
  snapshot,
  eligiblePlan,
} from '../subscription/subscription.entitlements.js';
import { recordAudit } from '../audit/audit.record.js';
import { sslcommerz, type VerifiedOrder } from './sslcommerz.js';
const duration = (days: number) => days * 86400000;
async function activateAccount(
  tx: Prisma.TransactionClient,
  supplierId: string,
  userId: string,
  type: SupplierType,
) {
  await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
  await tx.supplier.update({
    where: { id: supplierId },
    data: { status: 'APPROVED', marketplaceVisible: true },
  });
  await tx.userRoleAssignment.upsert({
    where: { userId_role: { userId, role: roleFor(type) } },
    create: { userId, role: roleFor(type) },
    update: {},
  });
}
const ownerInclude = {
  subscription: {
    include: {
      supplier: { select: { userId: true, companyName: true, type: true } },
    },
  },
} as const;
function publicPayment(
  p: Prisma.PaymentTransactionGetPayload<{ include: typeof ownerInclude }>,
) {
  return {
    id: p.id,
    transactionId: p.transactionId,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    gatewayUrl: p.status === 'PENDING' ? p.gatewayUrl : null,
    createdAt: p.createdAt,
    paidAt: p.paidAt,
    reviewReason: p.reviewReason,
    planId: p.subscription.planId,
    planName: p.subscription.planName,
    supplierId: p.subscription.supplierId,
    companyName: p.subscription.supplier.companyName,
    subscriptionStatus: p.subscription.isCurrent
      ? effectiveState(p.subscription)
      : 'CANCELLED',
    startsAt: p.subscription.startsAt,
    endsAt: p.subscription.endsAt,
    activationMethod: p.subscription.activationMethod,
  };
}
export const paymentService = {
  async updateOnboarding(
    userId: string,
    data: ProfileInput & { updatedAt: string },
  ) {
    const own = await prisma.supplier.findUnique({ where: { userId } });
    if (!own) throw new AppError('Supplier not found', 404);
    return prisma.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, own.id);
      if (
        supplier.status !== 'PENDING' ||
        !supplier.user.isEmailVerified ||
        !['PENDING', 'ACTIVE'].includes(supplier.user.status)
      )
        throw new AppError(
          'Only pending supplier profiles can be edited here',
          403,
        );
      if (supplier.updatedAt.toISOString() !== data.updatedAt)
        throw new AppError('Profile changed. Reload before editing', 409);
      if (
        await tx.paymentTransaction.count({
          where: { userId, status: { in: ['PENDING', 'REVIEW'] } },
        })
      )
        throw new AppError(
          'Check your pending payment before changing company information',
          409,
        );
      const { updatedAt, ...profile } = data;
      void updatedAt;
      const logoAssetId = await bindSupplierAssets(tx, own.id, userId, profile);
      return tx.supplier.update({
        where: { id: own.id },
        data: { ...profile, logoAssetId },
      });
    });
  },
  async onboarding(userId: string) {
    const supplier = await prisma.supplier.findUnique({
      where: { userId },
      include: { subscriptions: { where: { isCurrent: true } } },
    });
    if (!supplier)
      throw new AppError(
        'Apply as a supplier before choosing a subscription',
        409,
      );
    const plans = await prisma.subscriptionPlan.findMany({
      where: { isActive: true, eligibleTypes: { has: supplier.type } },
      orderBy: { name: 'asc' },
    });
    const payments = await prisma.paymentTransaction.findMany({
      where: { userId },
      include: ownerInclude,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return {
      supplier,
      plans,
      payments: payments.map(publicPayment),
      onlineAvailable: sslcommerz.isConfigured(),
      currencies: config.SSLCOMMERZ_CURRENCIES.split(','),
    };
  },
  async checkout(
    userId: string,
    data: { planId: string; idempotencyKey: string },
  ) {
    if (
      !config.SSLCOMMERZ_STORE_ID ||
      !config.SSLCOMMERZ_STORE_PASSWORD ||
      !config.PAYMENT_CALLBACK_ORIGIN
    )
      throw new AppError(
        'Online activation is not configured. Contact an administrator.',
        503,
      );
    sslcommerz.assertConfigured();
    const own = await prisma.supplier.findUnique({ where: { userId } });
    if (!own) throw new AppError('Supplier profile required', 409);
    const reserved = await prisma.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, own.id);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (
        !user.isEmailVerified ||
        !['PENDING', 'ACTIVE'].includes(user.status) ||
        !['PENDING', 'APPROVED'].includes(supplier.status)
      )
        throw new AppError('Account cannot start checkout', 403);
      const same = await tx.paymentTransaction.findUnique({
        where: {
          userId_idempotencyKey: {
            userId,
            idempotencyKey: data.idempotencyKey,
          },
        },
      });
      if (same) {
        if (
          same.subscriptionId &&
          (
            await tx.supplierSubscription.findUniqueOrThrow({
              where: { id: same.subscriptionId },
            })
          ).planId !== data.planId
        )
          throw new AppError('Idempotency key belongs to another plan', 409);
        return { payment: same, initiate: false, user, supplier };
      }
      const pending = await tx.paymentTransaction.findFirst({
        where: { userId, status: { in: ['PENDING', 'REVIEW'] } },
      });
      if (pending)
        throw new AppError(
          'Check your pending payment before starting another attempt',
          409,
        );
      const current = supplier.subscriptions[0];
      if (current && effectiveState(current) === 'ACTIVE')
        throw new AppError('An active subscription already exists', 409);
      if (current && ['SUSPENDED', 'CANCELLED'].includes(current.state))
        throw new AppError(
          'Contact an administrator about this subscription',
          403,
        );
      const plan = await eligiblePlan(
        tx,
        data.planId,
        supplier.id,
        supplier.type,
      );
      if (
        !config.SSLCOMMERZ_CURRENCIES.split(',').includes(plan.currency) ||
        plan.price.lte(0)
      )
        throw new AppError('This plan requires manual activation', 409);
      let term = current;
      if (
        !term ||
        term.state !== 'PENDING' ||
        term.planId !== plan.id ||
        term.planVersion?.getTime() !== plan.updatedAt.getTime()
      ) {
        await tx.supplierSubscription.updateMany({
          where: { supplierId: supplier.id, isCurrent: true },
          data: { isCurrent: false, state: 'CANCELLED' },
        });
        const now = new Date();
        term = await tx.supplierSubscription.create({
          data: {
            supplierId: supplier.id,
            ...snapshot(plan, supplier.type),
            state: 'PENDING',
            startsAt: now,
            endsAt: new Date(now.getTime() + duration(plan.durationDays)),
          },
        });
      }
      const payment = await tx.paymentTransaction.create({
        data: {
          userId,
          subscriptionId: term.id,
          idempotencyKey: data.idempotencyKey,
          transactionId: `imet_${randomBytes(12).toString('hex')}`,
          amount: term.price,
          currency: term.currency,
          expiresAt: new Date(Date.now() + 30 * 60000),
        },
      });
      return { payment, initiate: true, user, supplier };
    });
    if (reserved.initiate) {
      try {
        const session = await sslcommerz.initiate({
          transactionId: reserved.payment.transactionId,
          amount: reserved.payment.amount.toFixed(2),
          currency: reserved.payment.currency,
          product: 'Supplier subscription',
          email: reserved.user.email,
          name: reserved.supplier.contactName,
          phone: reserved.supplier.businessPhone,
          address: reserved.supplier.address,
          city: reserved.supplier.city,
          country: reserved.supplier.country,
        });
        await prisma.paymentTransaction.updateMany({
          where: { id: reserved.payment.id, status: 'PENDING' },
          data: session,
        });
      } catch (error) {
        // A timeout can occur after the gateway accepted the request. Keep it pending for reconciliation.
        if (error instanceof AppError && error.statusCode === 502)
          await prisma.paymentTransaction.updateMany({
            where: { id: reserved.payment.id, status: 'PENDING' },
            data: { status: 'FAILED' },
          });
        throw error;
      }
    }
    return this.get(userId, reserved.payment.id);
  },
  async get(userId: string, id: string) {
    const payment = await prisma.paymentTransaction.findFirst({
      where: { id, userId },
      include: ownerInclude,
    });
    if (!payment) throw new AppError('Payment not found', 404);
    return publicPayment(payment);
  },
  async accept(order: VerifiedOrder) {
    if (!['VALID', 'VALIDATED'].includes(order.status))
      throw new AppError('Payment has not been validated', 400);
    const found = await prisma.paymentTransaction.findUnique({
      where: { transactionId: order.tran_id },
      include: { subscription: true },
    });
    if (!found) throw new AppError('Unknown payment transaction', 404);
    const currency = order.currency_type ?? order.currency;
    const amount = order.currency_amount ?? order.amount;
    let matching = false;
    try {
      matching =
        currency === found.currency &&
        new Prisma.Decimal(amount).equals(found.amount);
    } catch {
      /* fail closed */
    }
    if (!matching || !order.val_id)
      throw new AppError('Payment amount or currency does not match', 400);
    return prisma.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, found.subscription.supplierId);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM payment_transactions WHERE id = ${found.id} FOR UPDATE`;
      const payment = await tx.paymentTransaction.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (['PAID', 'REVIEW'].includes(payment.status)) {
        if (payment.validationId !== order.val_id)
          throw new AppError('Validation identity changed', 409);
        return;
      }
      const duplicate = await tx.paymentTransaction.findUnique({
        where: { validationId: order.val_id },
      });
      if (duplicate && duplicate.id !== payment.id)
        throw new AppError(
          'Validation already belongs to another transaction',
          409,
        );
      const user = await tx.user.findUniqueOrThrow({
        where: { id: found.userId },
      });
      const term = supplier.subscriptions[0];
      const reason =
        order.risk_level !== '0'
          ? 'Gateway risk review required'
          : !user.isEmailVerified ||
              !['ACTIVE', 'PENDING'].includes(user.status) ||
              !['APPROVED', 'PENDING'].includes(supplier.status)
            ? 'Account is not eligible for automatic activation'
            : !term ||
                term.id !== payment.subscriptionId ||
                term.state !== 'PENDING' ||
                term.supplierType !== supplier.type
              ? 'Subscription was replaced or is no longer pending'
              : null;
      const now = new Date();
      await tx.paymentTransaction.update({
        where: { id: payment.id },
        data: {
          status: reason ? 'REVIEW' : 'PAID',
          validationId: order.val_id,
          gatewayStatus: order.status,
          gatewayTransactionId: order.bank_tran_id,
          riskLevel: order.risk_level,
          reviewReason: reason,
          paidAt: now,
          gatewayResponse: {
            status: order.status,
            tran_id: order.tran_id,
            val_id: order.val_id,
            amount,
            currency: currency ?? '',
            risk_level: order.risk_level,
          },
          lastCheckedAt: now,
        },
      });
      if (!reason && term) {
        await tx.supplierSubscription.update({
          where: { id: term.id },
          data: {
            state: 'ACTIVE',
            startsAt: now,
            endsAt: new Date(now.getTime() + duration(term.durationDays)),
            activationMethod: 'PAYMENT',
            activatedAt: now,
          },
        });
        await activateAccount(tx, supplier.id, supplier.userId, supplier.type);
      }
    });
  },
  async notify(transactionId: string, validationId?: string): Promise<void> {
    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionId },
    });
    if (!payment) throw new AppError('Unknown payment transaction', 404);
    if (validationId) {
      const order = await sslcommerz.validate(validationId);
      if (order.tran_id !== transactionId || order.val_id !== validationId)
        throw new AppError('Validation identity does not match', 400);
      await this.accept(order);
      return;
    }
    const records = await sslcommerz.query(transactionId);
    const record = records.find(
      (r) =>
        r.tran_id === transactionId &&
        ['VALID', 'VALIDATED'].includes(r.status),
    );
    if (record?.val_id) return this.notify(transactionId, record.val_id);
    const terminal = records.find(
      (r) =>
        r.tran_id === transactionId &&
        ['FAILED', 'CANCELLED', 'EXPIRED'].includes(r.status),
    );
    if (terminal)
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: terminal.status as 'FAILED' | 'CANCELLED' | 'EXPIRED',
          gatewayStatus: terminal.status,
          lastCheckedAt: new Date(),
        },
      });
    // Only expire an unconfirmed attempt after a successful authoritative lookup reports no transaction.
    else if (!records.length && payment.expiresAt < new Date())
      await prisma.paymentTransaction.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'EXPIRED', lastCheckedAt: new Date() },
      });
  },
  async reconcile(userId: string, id: string) {
    const payment = await prisma.paymentTransaction.findFirst({
      where: { id, userId },
    });
    if (!payment) throw new AppError('Payment not found', 404);
    if (payment.status === 'PENDING') {
      const claimed = await prisma.paymentTransaction.updateMany({
        where: {
          id,
          status: 'PENDING',
          OR: [
            { lastCheckedAt: null },
            { lastCheckedAt: { lt: new Date(Date.now() - 15000) } },
          ],
        },
        data: { lastCheckedAt: new Date() },
      });
      if (claimed.count) await this.notify(payment.transactionId);
    }
    return this.get(userId, id);
  },
  async adminPayments(supplierId: string) {
    return prisma.paymentTransaction.findMany({
      where: { subscription: { supplierId } },
      select: {
        id: true,
        transactionId: true,
        amount: true,
        currency: true,
        status: true,
        gatewayStatus: true,
        validationId: true,
        riskLevel: true,
        reviewReason: true,
        paidAt: true,
        createdAt: true,
        subscription: { select: { planName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  },
  async manual(
    actorId: string,
    supplierId: string,
    data: {
      planId: string;
      startsAt: string;
      endsAt: string;
      reason: string;
      confirmed: true;
      updatedAt: string;
      expectedCurrentId: string | null;
      expectedCurrentUpdatedAt: string | null;
    },
  ) {
    return prisma.$transaction(async (tx) => {
      const supplier = await lockSupplier(tx, supplierId);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${supplier.userId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: supplier.userId },
      });
      if (
        !user.isEmailVerified ||
        !['PENDING', 'ACTIVE'].includes(user.status) ||
        !['PENDING', 'APPROVED'].includes(supplier.status)
      )
        throw new AppError(
          'Only verified, eligible accounts can be activated',
          409,
        );
      const current = supplier.subscriptions[0];
      if (
        supplier.updatedAt.toISOString() !== data.updatedAt ||
        (current?.id ?? null) !== data.expectedCurrentId ||
        (current?.updatedAt.toISOString() ?? null) !==
          data.expectedCurrentUpdatedAt
      )
        throw new AppError(
          'Supplier or subscription changed. Reload before activating',
          409,
        );
      if (new Date(data.endsAt) <= new Date())
        throw new AppError('Activation end date must be in the future', 400);
      const plan = await eligiblePlan(
        tx,
        data.planId,
        supplierId,
        supplier.type,
      );
      await tx.supplierSubscription.updateMany({
        where: { supplierId, isCurrent: true },
        data: { isCurrent: false, state: 'CANCELLED' },
      });
      const term = await tx.supplierSubscription.create({
        data: {
          supplierId,
          ...snapshot(plan, supplier.type),
          state: 'ACTIVE',
          startsAt: new Date(data.startsAt),
          endsAt: new Date(data.endsAt),
          activationMethod: 'ADMIN_MANUAL',
          activatedById: actorId,
          activatedAt: new Date(),
          activationReason: data.reason,
        },
      });
      await activateAccount(tx, supplierId, supplier.userId, supplier.type);
      await recordAudit(
        tx,
        actorId,
        'SUPPLIER_MANUAL_ACTIVATION',
        'SUBSCRIPTION',
        term.id,
        [
          'planId',
          'startsAt',
          'endsAt',
          'activationMethod',
          'activationReason',
        ],
        {},
        term,
        {
          activationMethod: 'ADMIN_MANUAL',
          activationReason: data.reason,
          targetUserId: supplier.userId,
        },
      );
      return { ...term, effectiveStatus: effectiveState(term) };
    });
  },
};
