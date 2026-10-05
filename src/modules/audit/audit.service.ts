import {
  Prisma,
  UserStatus,
  UserRole,
  MachineStatus,
  SupplierStatus,
  ReviewStatus,
  SubscriptionState,
  ServiceTicketStatus,
  SalesStage,
} from '../../generated/client.js';
import { prisma } from '../../config/database.js';
import { dateRange } from '../analytics/analytics.validation.js';
import type { AuditQuery } from './audit.validation.js';
const states = new Set<string>([
  ...Object.values(UserStatus),
  ...Object.values(MachineStatus),
  ...Object.values(SupplierStatus),
  ...Object.values(ReviewStatus),
  ...Object.values(SubscriptionState),
  ...Object.values(ServiceTicketStatus),
  ...Object.values(SalesStage),
  'LOCAL',
  'INTERNATIONAL',
]);
export function safeContext(value: unknown) {
  const object = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v))
      : {};
  const context = object(value);
  const state = (value: unknown) => {
    const safe: Record<string, string | boolean | string[]> = {};
    for (const [key, v] of Object.entries(object(value))) {
      if (
        ['status', 'state', 'type'].includes(key) &&
        typeof v === 'string' &&
        states.has(v)
      )
        safe[key] = v;
      if (
        ['isActive', 'isVerified', 'marketplaceVisible'].includes(key) &&
        typeof v === 'boolean'
      )
        safe[key] = v;
      if (key === 'roles' && Array.isArray(v))
        safe[key] = v.filter(
          (r): r is string =>
            typeof r === 'string' &&
            Object.values(UserRole).some((role) => role === r),
        );
      if (
        ['startsAt', 'endsAt'].includes(key) &&
        typeof v === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
      )
        safe[key] = v;
    }
    return safe;
  };
  return {
    changedFields: Array.isArray(context.changedFields)
      ? context.changedFields.filter(
          (v): v is string =>
            typeof v === 'string' &&
            /^[a-zA-Z][a-zA-Z0-9]{0,59}$/.test(v) &&
            !/password|token|secret|credential/i.test(v),
        )
      : [],
    before: state(context.before),
    after: state(context.after),
  };
}
export const auditService = {
  list: (q: AuditQuery) =>
    prisma.$transaction(
      async (tx) => {
        const range = dateRange(q);
        const sources = Prisma.sql`
   SELECT id,"actorId",action,"resourceType"::text AS "resourceType","resourceId",context,"createdAt",'ADMIN'::text AS source FROM audit_logs
   UNION ALL SELECT id,"actorId","eventType",'RFQ',"rfqId",'{}'::jsonb,"createdAt",'RFQ' FROM rfq_events
   UNION ALL SELECT id,"actorId","eventType",'SALES_OPPORTUNITY',"opportunityId",'{}'::jsonb,"createdAt",'SALES' FROM sales_events
   UNION ALL SELECT id,"actorId",type,'SERVICE_TICKET',"ticketId",jsonb_build_object('before',jsonb_build_object('status',"fromStatus"),'after',jsonb_build_object('status',"toStatus")),"createdAt",'SERVICE' FROM service_ticket_events`;
        const conditions = Prisma.sql`e."createdAt">=${range.start} AND e."createdAt"<${range.end}
   ${q.source ? Prisma.sql`AND e.source=${q.source}` : Prisma.empty}
   ${q.actorId ? Prisma.sql`AND e."actorId"=${q.actorId}` : Prisma.empty}
   ${q.action ? Prisma.sql`AND e.action=${q.action}` : Prisma.empty}
   ${q.resourceType ? Prisma.sql`AND e."resourceType"=${q.resourceType}` : Prisma.empty}
   ${q.resourceId ? Prisma.sql`AND e."resourceId"=${q.resourceId}` : Prisma.empty}`;
        const [{ total }] = await tx.$queryRaw<{ total: number }[]>(
          Prisma.sql`WITH events AS (${sources}) SELECT count(*)::int AS total FROM events e WHERE ${conditions}`,
        );
        const rows = await tx.$queryRaw<
          {
            id: string;
            actorId: string | null;
            actorName: string | null;
            action: string;
            resourceType: string;
            resourceId: string;
            context: unknown;
            createdAt: Date;
            source: string;
          }[]
        >(
          Prisma.sql`WITH events AS (${sources}) SELECT e.*,u."displayName" AS "actorName" FROM events e LEFT JOIN users u ON u.id=e."actorId" WHERE ${conditions} ORDER BY e."createdAt" DESC,e.source ASC,e.id DESC LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        );
        return {
          entries: rows.map((r) => ({
            id: r.source + ':' + r.id,
            source: r.source,
            action: r.action,
            resourceType: r.resourceType,
            resourceId: r.resourceId,
            actor: { id: r.actorId, displayName: r.actorName },
            createdAt: r.createdAt.toISOString(),
            context: safeContext(r.context),
          })),
          pagination: {
            page: q.page,
            limit: q.limit,
            total,
            totalPages: Math.ceil(total / q.limit),
          },
          range: { from: range.from, to: range.to, timeZone: range.timeZone },
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    ),
};
