import { z } from 'zod';
import { UserRole, UserStatus } from '../../generated/enums.js';
export const listSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
});
export const updateSchema = z.object({
  params: z.object({ id: z.uuid() }),
  body: z
    .object({
      status: z.enum(UserStatus).optional(),
      roles: z
        .array(z.enum(UserRole))
        .min(1)
        .max(6)
        .refine(
          (roles) => new Set(roles).size === roles.length,
          'Roles must be unique',
        )
        .optional(),
    })
    .strict()
    .refine(
      (data) => data.status !== undefined || data.roles !== undefined,
      'Provide status or roles',
    ),
});
export const profileSchema = z.object({
  body: z.object({ displayName: z.string().trim().min(2).max(100) }).strict(),
});
