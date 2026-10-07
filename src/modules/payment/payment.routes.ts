import { profileBody } from '../supplier/supplier.validation.js';
import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { prisma } from '../../config/database.js';
import { config } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
import { paymentService as service } from './payment.service.js';
import {
  checkoutSchema,
  manualActivationSchema,
  paymentIdSchema,
} from './payment.validation.js';
export const PaymentRoutes = Router();
const notification = z.object({
  tran_id: z.string().regex(/^imet_[a-f0-9]{24}$/),
  val_id: z.string().min(1).max(100).optional(),
});
PaymentRoutes.post(
  '/ipn',
  express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 100 }),
  catchAsync(async (req, res) => {
    const data = notification.parse(req.body);
    await service.notify(data.tran_id, data.val_id);
    ResponseHandler.ok(res, 'Notification verified');
  }),
);
PaymentRoutes.all(
  '/callback/:result',
  express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 100 }),
  catchAsync(async (req, res) => {
    // Redirect outcomes are informational. They never mutate financial or account state.
    const data = notification.parse(
      req.method === 'GET' ? req.query : req.body,
    );
    const payment = await prisma.paymentTransaction.findUnique({
      where: { transactionId: data.tran_id },
      select: { id: true },
    });
    if (!payment) throw new AppError('Payment not found', 404);
    res.redirect(
      303,
      `${new URL(config.FRONTEND_URL).origin}/payments/${payment.id}`,
    );
  }),
);
PaymentRoutes.use(authenticate([], true));
PaymentRoutes.get(
  '/onboarding',
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Supplier onboarding',
      await service.onboarding(res.locals.auth.id),
    ),
  ),
);
PaymentRoutes.patch(
  '/onboarding',
  validate(
    z.object({ body: profileBody.extend({ updatedAt: z.iso.datetime() }) }),
  ),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Company profile updated',
      await service.updateOnboarding(
        res.locals.auth.id,
        res.locals.validated.body,
      ),
    ),
  ),
);
PaymentRoutes.post(
  '/checkout',
  validate(checkoutSchema),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Checkout created',
      await service.checkout(res.locals.auth.id, res.locals.validated.body),
    ),
  ),
);
PaymentRoutes.get(
  '/:id',
  validate(paymentIdSchema),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Payment',
      await service.get(res.locals.auth.id, res.locals.validated.params.id),
    ),
  ),
);
PaymentRoutes.post(
  '/:id/reconcile',
  validate(paymentIdSchema),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Payment checked',
      await service.reconcile(
        res.locals.auth.id,
        res.locals.validated.params.id,
      ),
    ),
  ),
);
export const PaymentAdminRoutes = Router();
PaymentAdminRoutes.use(authenticate(['ADMIN']));
PaymentAdminRoutes.get(
  '/suppliers/:id/payments',
  validate(paymentIdSchema),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Supplier payments',
      await service.adminPayments(res.locals.validated.params.id),
    ),
  ),
);
PaymentAdminRoutes.post(
  '/suppliers/:id/activate',
  validate(manualActivationSchema),
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Supplier manually activated',
      await service.manual(
        res.locals.auth.id,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    ),
  ),
);
