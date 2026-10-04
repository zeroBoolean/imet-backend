import { z } from 'zod';
export const language = z.enum(['en', 'bn', 'zh']);
export const resourceType = z.enum([
  'MACHINERY',
  'SPECIFICATION',
  'SUPPLIER',
  'REVIEW',
]);
export const reference = z
  .object({
    type: resourceType,
    id: z.uuid(),
    field: z.enum(['NAME', 'DESCRIPTION', 'LABEL', 'BODY']),
  })
  .strict()
  .superRefine((r, ctx) => {
    const allowed = {
      MACHINERY: ['NAME', 'DESCRIPTION'],
      SPECIFICATION: ['LABEL'],
      SUPPLIER: ['DESCRIPTION'],
      REVIEW: ['BODY'],
    };
    if (!allowed[r.type].includes(r.field))
      ctx.addIssue({
        code: 'custom',
        message: 'Unsupported translation field',
        path: ['field'],
      });
  });
const empty = z.object({}).strict();
const params = z
  .object({ type: z.enum(['MACHINERY', 'SUPPLIER', 'REVIEW']), id: z.uuid() })
  .strict();
export const translationSchemas = {
  read: z.object({
    body: z
      .object({
        targetLanguage: language,
        resources: z.array(reference).min(1).max(40),
      })
      .strict(),
    params: empty,
    query: empty,
  }),
  generate: z.object({
    body: z
      .object({
        resource: reference,
        sourceLanguage: language,
        targetLanguage: language,
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
        regenerate: z.boolean().default(false),
      })
      .strict(),
    params: empty,
    query: empty,
  }),
  list: z.object({
    body: z.unknown().optional(),
    params: empty,
    query: z
      .object({
        type: z.enum(['MACHINERY', 'SUPPLIER', 'REVIEW']).default('MACHINERY'),
        q: z.string().trim().max(100).default(''),
        page: z.coerce.number().int().min(1).max(10000).default(1),
        limit: z.coerce.number().int().min(1).max(20).default(10),
      })
      .strict(),
  }),
  detail: z.object({ body: z.unknown().optional(), params, query: empty }),
};
export type TranslationReference = z.infer<typeof reference>;
export type Language = z.infer<typeof language>;
export type GenerationInput = z.infer<
  typeof translationSchemas.generate
>['body'];
export type ResourceQuery = z.infer<typeof translationSchemas.list>['query'];
