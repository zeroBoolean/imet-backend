import { z } from 'zod';
import { rangeQuery } from '../analytics/analytics.validation.js';
export const auditQuery = rangeQuery(366)
  .safeExtend({
    source: z.enum(['ADMIN', 'RFQ', 'SALES', 'SERVICE']).optional(),
    actorId: z.uuid().optional(),
    action: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .optional(),
    resourceType: z
      .enum([
        'USER',
        'CATEGORY',
        'MACHINERY',
        'SUPPLIER',
        'SUBSCRIPTION_PLAN',
        'SUBSCRIPTION',
        'REVIEW',
        'RFQ',
        'SALES_OPPORTUNITY',
        'SERVICE_TICKET',
      ])
      .optional(),
    resourceId: z.uuid().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type AuditQuery = z.infer<typeof auditQuery>;
export const auditSchema = z.object({ query: auditQuery });
