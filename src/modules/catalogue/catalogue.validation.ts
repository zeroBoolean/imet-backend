import { z } from 'zod';
const slug = z
  .string()
  .max(220)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const catalogueQuery = z
  .object({
    q: z.string().trim().max(100).default(''),
    category: slug.max(120).optional(),
    supplier: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(48).default(12),
  })
  .strict();
export type CatalogueQuery = z.infer<typeof catalogueQuery>;
export const listSchema = z.object({ query: catalogueQuery });
export const detailSchema = z.object({ params: z.object({ slug }) });
