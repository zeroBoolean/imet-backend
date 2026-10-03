import { z } from 'zod';
const text = (max: number) => z.string().trim().min(1).max(max);
const slug = (max: number) => text(max).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const imageUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an HTTPS image URL without embedded credentials');
export const categoryBody = z
  .object({ name: text(100), slug: slug(120) })
  .strict();
export const machineBody = z
  .object({
    name: text(200),
    slug: slug(220),
    description: text(20000),
    manufacturer: text(200),
    model: text(200),
    categoryId: z.uuid(),
    status: z.enum(['DRAFT', 'PUBLISHED']).default('DRAFT'),
    images: z
      .array(z.object({ url: imageUrl, alt: text(250) }).strict())
      .max(20)
      .default([]),
    specifications: z
      .array(z.object({ label: text(100), value: text(500) }).strict())
      .max(100)
      .default([]),
  })
  .strict();
export type MachineInput = z.infer<typeof machineBody>;
export type CategoryInput = z.infer<typeof categoryBody>;
const params = z.object({ id: z.uuid() });
export const adminListQuery = z
  .object({
    q: z.string().trim().max(100).default(''),
    categoryId: z.uuid().optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type AdminListQuery = z.infer<typeof adminListQuery>;
const adminMachineBody = machineBody.extend({
  supplierId: z.uuid().nullable().optional(),
});
export const adminSchemas = {
  categoryCreate: z.object({ body: categoryBody }),
  categoryUpdate: z.object({ params, body: categoryBody }),
  id: z.object({ params }),
  list: z.object({ query: adminListQuery }),
  create: z.object({ body: adminMachineBody }),
  update: z.object({
    params,
    body: adminMachineBody.extend({ updatedAt: z.iso.datetime() }),
  }),
  remove: z.object({
    params,
    body: z.object({ updatedAt: z.iso.datetime() }).strict(),
  }),
};
