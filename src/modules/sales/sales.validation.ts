import { z } from 'zod';
const params = z.object({ id: z.uuid() });
const query = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    q: z.string().trim().max(100).default(''),
    stage: z
      .enum(['NEW', 'QUALIFIED', 'QUOTED', 'NEGOTIATION', 'WON', 'LOST'])
      .optional(),
    status: z.enum(['RECORDED', 'COMPLETED', 'CANCELLED']).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    sort: z.enum(['createdAt', 'updatedAt']).default('updatedAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
    view: z.enum(['buyer', 'seller']).default('seller'),
  })
  .strict()
  .refine(
    (q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to),
    'Date range is invalid',
  );
export type SalesQuery = z.infer<typeof query>;
export const salesSchemas = {
  list: z.object({ query }),
  id: z.object({ params }),
  update: z.object({
    params,
    body: z
      .object({
        updatedAt: z.iso.datetime(),
        stage: z.enum(['QUALIFIED', 'NEGOTIATION']).optional(),
        internalNotes: z.string().trim().max(5000).optional(),
      })
      .strict()
      .refine(
        (b) => b.stage !== undefined || b.internalNotes !== undefined,
        'Supply a stage or internal notes',
      ),
  }),
  record: z.object({
    params,
    body: z.object({ updatedAt: z.iso.datetime() }).strict(),
  }),
  saleUpdate: z.object({
    params,
    body: z
      .object({
        updatedAt: z.iso.datetime(),
        status: z.enum(['COMPLETED', 'CANCELLED']),
        reason: z.string().trim().min(1).max(2000).optional(),
      })
      .strict()
      .refine(
        (b) => b.status !== 'CANCELLED' || !!b.reason,
        'Cancellation reason is required',
      ),
  }),
};
