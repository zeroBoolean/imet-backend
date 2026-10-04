import { z } from 'zod';
const target = z.enum(['MACHINERY', 'SUPPLIER']);
const status = z.enum([
  'PENDING',
  'PUBLISHED',
  'REJECTED',
  'HIDDEN',
  'WITHDRAWN',
]);
const page = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
};
const fields = {
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(5000),
};
const id = z.object({ id: z.uuid() });
export const reviewSchemas = {
  publicList: z.object({
    query: z.object({ ...page, target, targetId: z.uuid() }).strict(),
  }),
  highlights: z.object({
    query: z
      .object({ limit: z.coerce.number().int().min(1).max(6).default(3) })
      .strict(),
  }),
  list: z.object({
    query: z
      .object({
        ...page,
        status: status.optional(),
        target: target.optional(),
        q: z.string().trim().max(100).default(''),
      })
      .strict(),
  }),
  eligibility: z.object({ params: z.object({ saleId: z.uuid() }) }),
  create: z.object({
    body: z.object({ saleId: z.uuid(), target, ...fields }).strict(),
  }),
  update: z.object({
    params: id,
    body: z.object({ ...fields, updatedAt: z.iso.datetime() }).strict(),
  }),
  withdraw: z.object({
    params: id,
    body: z.object({ updatedAt: z.iso.datetime() }).strict(),
  }),
  moderate: z.object({
    params: id,
    body: z
      .object({
        updatedAt: z.iso.datetime(),
        status: z.enum(['PUBLISHED', 'REJECTED', 'HIDDEN']),
        note: z.string().trim().max(2000).default(''),
      })
      .strict(),
  }),
};
export type ReviewQuery = z.infer<typeof reviewSchemas.list>['query'];
export type PublicReviewQuery = z.infer<
  typeof reviewSchemas.publicList
>['query'];
