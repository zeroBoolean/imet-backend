import { z } from 'zod';
export const planBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    eligibleTypes: z
      .array(z.enum(['LOCAL', 'INTERNATIONAL']))
      .min(1)
      .max(2)
      .refine(
        (items) => new Set(items).size === items.length,
        'Types must be unique',
      ),
    durationDays: z.number().int().min(1).max(36500),
    price: z
      .string()
      .regex(
        /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/,
        'Use a nonnegative decimal amount with up to two decimal places',
      ),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code'),
    listingLimit: z.number().int().min(1).max(100000),
    imageLimit: z.number().int().min(0).max(20),
    specificationLimit: z.number().int().min(0).max(100),
    rfqEnabled: z.boolean().optional(),
    leadLimitPerMonth: z.number().int().min(0).max(1000000).nullable().optional(),
    canRevealContacts: z.boolean().optional(),
    canPublishMachinery: z.boolean(),
    visibility: z.enum(['HIDDEN', 'STANDARD', 'FEATURED']),
    isActive: z.boolean(),
  })
  .strict();
export type PlanInput = z.infer<typeof planBody>;
export const termBody = z
  .object({
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    state: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'CANCELLED']),
  })
  .strict();
const validDates = (body: { startsAt: string; endsAt: string }) =>
  new Date(body.endsAt) > new Date(body.startsAt);
export const subscriptionSchemas = {
  planCreate: z.object({ body: planBody }),
  planUpdate: z.object({
    params: z.object({ id: z.uuid() }),
    body: planBody.extend({ updatedAt: z.iso.datetime() }),
  }),
  assign: z.object({
    params: z.object({ id: z.uuid() }),
    body: termBody
      .extend({
        planId: z.uuid(),
        expectedCurrentId: z.uuid().nullable(),
        expectedCurrentUpdatedAt: z.iso.datetime().nullable(),
      })
      .refine(validDates, 'End must be after start'),
  }),
  update: z.object({
    params: z.object({ id: z.uuid() }),
    body: termBody
      .extend({ updatedAt: z.iso.datetime() })
      .refine(validDates, 'End must be after start'),
  }),
};
