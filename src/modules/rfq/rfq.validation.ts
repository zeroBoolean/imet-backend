import { z } from 'zod';
const text = (max: number) => z.string().trim().min(1).max(max);
const decimal = (maxDigits: number, scale: number, positive = false) =>
  z
    .string()
    .regex(
      new RegExp(`^(0|[1-9]\\d{0,${maxDigits - 1}})(\\.\\d{1,${scale}})?$`),
      'Use a decimal amount without separators',
    )
    .refine((v) => !positive || Number(v) > 0, 'Must be greater than zero');
export const rfqBody = z
  .object({
    machineId: z.uuid().nullable().default(null),
    categoryId: z.uuid().nullable().default(null),
    title: text(200),
    description: text(20000),
    quantity: decimal(11, 3, true),
    unit: text(40),
    targetBudget: decimal(14, 2).nullable().default(null),
    budgetCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    deliveryLocation: text(2000),
    deliveryTimeline: text(500),
    supplierCountry: text(100).nullable().default(null),
    preferredLanguage: z.enum(['en', 'bn', 'zh']).default('en'),
  })
  .strict()
  .refine(
    (b) => (b.targetBudget === null) === (b.budgetCurrency === null),
    'Budget amount and currency must be provided together',
  );
export type RfqInput = z.infer<typeof rfqBody>;
export const quoteBody = z
  .object({
    unitPrice: decimal(14, 2),
    currency: z.string().regex(/^[A-Z]{3}$/),
    moq: decimal(11, 3, true),
    leadTimeDays: z.number().int().min(0).max(3650),
    validUntil: z.iso.datetime(),
    notes: z.string().trim().max(20000).default(''),
  })
  .strict()
  .refine(
    (b) => new Date(b.validUntil) > new Date(),
    'Quote validity must be in the future',
  );
export type QuoteInput = z.infer<typeof quoteBody>;
const version = z.object({ updatedAt: z.iso.datetime() }).strict();
const query = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    q: z.string().trim().max(100).default(''),
    status: z
      .enum([
        'DRAFT',
        'SUBMITTED',
        'ROUTED',
        'QUOTED',
        'ACCEPTED',
        'CLOSED',
        'CANCELLED',
        'EXPIRED',
        'DECLINED',
      ])
      .optional(),
    leadStatus: z
      .enum(['NEW', 'VIEWED', 'QUOTED', 'DECLINED', 'CLOSED'])
      .optional(),
    categoryId: z.uuid().optional(),
    buyerId: z.uuid().optional(),
    recipientId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    minValue: decimal(14, 2).optional(),
    maxValue: decimal(14, 2).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict()
  .refine(
    (q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to),
    'End date must be after start',
  )
  .refine(
    (q) => (!q.minValue && !q.maxValue) || !!q.currency,
    'Value filters require a currency',
  );
export type RfqQuery = z.infer<typeof query>;
const params = z.object({ id: z.uuid() });
export const quoteQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    q: z.string().trim().max(100).default(''),
    status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN']).optional(),
  })
  .strict();
export type QuoteQuery = z.infer<typeof quoteQuery>;
export const rfqSchemas = {
  quoteList: z.object({ query: quoteQuery }),
  overview: z.object({
    query: quoteQuery.pick({ page: true, limit: true, q: true }),
  }),
  create: z.object({ body: rfqBody }),
  update: z.object({
    params,
    body: rfqBody.safeExtend({ updatedAt: z.iso.datetime() }),
  }),
  id: z.object({ params }),
  list: z.object({ query }),
  action: z.object({ params, body: version }),
  quote: z.object({ params, body: quoteBody }),
  quoteUpdate: z.object({
    params,
    body: quoteBody.safeExtend({ updatedAt: z.iso.datetime() }),
  }),
  recipients: z.object({
    params,
    body: z
      .object({
        userIds: z.array(z.uuid()).min(1).max(100),
        action: z.enum(['ADD', 'REMOVE']),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
  }),
  flag: z.object({
    params,
    body: z
      .object({
        isFlagged: z.boolean(),
        reason: text(2000),
        blockSupplierContact: z.boolean().default(false),
        updatedAt: z.iso.datetime(),
      })
      .strict(),
  }),
  message: z.object({
    params,
    body: z.object({ recipientId: z.uuid(), body: text(5000) }).strict(),
  }),
  thread: z.object({
    params,
    query: z
      .object({ recipientId: z.uuid(), before: z.iso.datetime().optional() })
      .strict(),
  }),
};
