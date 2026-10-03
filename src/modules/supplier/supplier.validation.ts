import { z } from 'zod';
const text = (max: number) => z.string().trim().min(1).max(max);
export const httpsUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use an HTTPS URL without embedded credentials');
const nullableUrl = httpsUrl.nullable();
export const profileBody = z
  .object({
    companyName: text(200),
    type: z.enum(['LOCAL', 'INTERNATIONAL']),
    description: text(20000),
    contactName: text(100),
    businessEmail: z.email().trim().toLowerCase().max(254),
    businessPhone: text(40),
    address: text(2000),
    city: text(100),
    country: text(100),
    registrationNumber: text(150).nullable(),
    website: nullableUrl,
    logoUrl: nullableUrl,
    documents: z
      .array(z.object({ name: text(200), url: httpsUrl }).strict())
      .max(20),
  })
  .strict();
export type ProfileInput = z.infer<typeof profileBody>;
export const permittedProfileBody = profileBody.pick({
  description: true,
  contactName: true,
  businessEmail: true,
  businessPhone: true,
  website: true,
  logoUrl: true,
});
export const paging = z
  .object({
    q: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const params = z.object({ id: z.uuid() });
export const supplierSchemas = {
  apply: z.object({ body: profileBody }),
  ownUpdate: z.object({
    body: permittedProfileBody.extend({ updatedAt: z.iso.datetime() }),
  }),
  list: z.object({
    query: paging.extend({
      status: z
        .enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'INACTIVE'])
        .optional(),
    }),
  }),
  publicList: z.object({ query: paging }),
  id: z.object({ params }),
  adminProfile: z.object({
    params,
    body: profileBody.extend({ updatedAt: z.iso.datetime() }),
  }),
  review: z.object({
    params,
    body: z
      .object({
        status: z.enum([
          'PENDING',
          'APPROVED',
          'REJECTED',
          'SUSPENDED',
          'INACTIVE',
        ]),
        isVerified: z.boolean(),
        marketplaceVisible: z.boolean(),
        reviewNote: text(2000).nullable(),
        updatedAt: z.iso.datetime(),
      })
      .strict()
      .refine(
        (body) => body.status !== 'REJECTED' || !!body.reviewNote,
        'Provide a rejection reason',
      ),
  }),
};
