import { z } from 'zod';
import { registerSchema } from '../auth/auth.validation.js';
import { profileBody } from '../supplier/supplier.validation.js';
export const supplierRegistration = z.object({
  body: registerSchema.shape.body
    .extend({ profile: profileBody, planId: z.uuid() })
    .strict(),
});
export const checkoutSchema = z.object({
  body: z.object({ planId: z.uuid(), idempotencyKey: z.uuid() }).strict(),
});
export const paymentIdSchema = z.object({ params: z.object({ id: z.uuid() }) });
export const manualActivationSchema = z.object({
  params: z.object({ id: z.uuid() }),
  body: z
    .object({
      planId: z.uuid(),
      startsAt: z.iso.datetime(),
      endsAt: z.iso.datetime(),
      reason: z.string().trim().min(10).max(2000),
      confirmed: z.literal(true),
      updatedAt: z.iso.datetime(),
      expectedCurrentId: z.uuid().nullable(),
      expectedCurrentUpdatedAt: z.iso.datetime().nullable(),
    })
    .strict()
    .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
      path: ['endsAt'],
      message: 'End date must follow start date',
    }),
});
