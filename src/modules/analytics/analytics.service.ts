import { prisma } from '../../config/database.js';
import { dateRange } from './analytics.validation.js';
export const analyticsService = {
  overview: (query: { from?: string; to?: string }) =>
    prisma.$transaction(
      async (tx) => {
        const [{ asOf }] = await tx.$queryRaw<
          { asOf: Date }[]
        >`SELECT transaction_timestamp() AS "asOf"`;
        const range = dateRange(query, asOf);
        const [
          users,
          roles,
          machinery,
          suppliers,
          supplierTypes,
          rfqs,
          opportunities,
          sales,
          reviews,
          tickets,
          warranty,
          rfqEmails,
          serviceEmails,
        ] = await Promise.all([
          tx.user.groupBy({ by: ['status'], _count: true }),
          tx.userRoleAssignment.groupBy({ by: ['role'], _count: true }),
          tx.machine.groupBy({ by: ['status'], _count: true }),
          tx.supplier.groupBy({ by: ['status'], _count: true }),
          tx.supplier.groupBy({ by: ['type'], _count: true }),
          tx.rfq.groupBy({ by: ['status'], _count: true }),
          tx.salesOpportunity.groupBy({ by: ['stage'], _count: true }),
          tx.saleRecord.groupBy({ by: ['status'], _count: true }),
          tx.review.groupBy({ by: ['status'], _count: true }),
          tx.serviceTicket.groupBy({ by: ['status'], _count: true }),
          tx.serviceTicket.groupBy({
            by: ['warrantyAssessment'],
            _count: true,
          }),
          tx.rfqEmailDelivery.groupBy({ by: ['status'], _count: true }),
          tx.notificationEmailDelivery.groupBy({
            by: ['status'],
            _count: true,
          }),
        ]);
        const subscriptions = await tx.$queryRaw<
          { key: string; count: number }[]
        >`SELECT CASE
   WHEN state IN ('CANCELLED','SUSPENDED') THEN state::text
   WHEN "endsAt" <= ${asOf} THEN 'EXPIRED'
   WHEN state = 'PENDING' OR "startsAt" > ${asOf} THEN 'PENDING'
   ELSE 'ACTIVE' END AS key, count(*)::int AS count FROM supplier_subscriptions WHERE "isCurrent" = true GROUP BY 1`;
        const group = (rows: { _count: number }[], keys: string[]) => ({
          total: rows.reduce((sum, r) => sum + r._count, 0),
          counts: Object.fromEntries(rows.map((r, i) => [keys[i], r._count])),
        });
        const current = {
          users: group(
            users,
            users.map((r) => r.status),
          ),
          userRoles: group(
            roles,
            roles.map((r) => r.role),
          ),
          machinery: group(
            machinery,
            machinery.map((r) => r.status),
          ),
          suppliers: group(
            suppliers,
            suppliers.map((r) => r.status),
          ),
          supplierTypes: group(
            supplierTypes,
            supplierTypes.map((r) => r.type),
          ),
          subscriptions: {
            total: subscriptions.reduce((s, r) => s + r.count, 0),
            counts: Object.fromEntries(
              subscriptions.map((r) => [r.key, r.count]),
            ),
          },
          rfqs: group(
            rfqs,
            rfqs.map((r) => r.status),
          ),
          opportunities: group(
            opportunities,
            opportunities.map((r) => r.stage),
          ),
          sales: group(
            sales,
            sales.map((r) => r.status),
          ),
          reviews: group(
            reviews,
            reviews.map((r) => r.status),
          ),
          service: group(
            tickets,
            tickets.map((r) => r.status),
          ),
          warranty: group(
            warranty,
            warranty.map((r) => r.warrantyAssessment),
          ),
          rfqEmails: group(
            rfqEmails,
            rfqEmails.map((r) => r.status),
          ),
          serviceEmails: group(
            serviceEmails,
            serviceEmails.map((r) => r.status),
          ),
        };
        const activity = await tx.$queryRaw<
          { date: string; kind: string; count: number }[]
        >`
   WITH activity AS (
    SELECT "createdAt", 'users' AS kind FROM users UNION ALL SELECT "createdAt",'machinery' FROM machines
    UNION ALL SELECT "createdAt",'suppliers' FROM suppliers UNION ALL SELECT "createdAt",'rfqs' FROM rfqs
    UNION ALL SELECT "createdAt",'sales' FROM sale_records UNION ALL SELECT "createdAt",'reviews' FROM reviews
    UNION ALL SELECT "createdAt",'service' FROM service_tickets
   ) SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD') AS date, kind, count(*)::int AS count
   FROM activity WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end} GROUP BY 1,2 ORDER BY 1,2`;
        const days = [];
        for (
          let at = Date.parse(range.from);
          at <= Date.parse(range.to);
          at += 86400000
        ) {
          const date = new Date(at).toISOString().slice(0, 10);
          const counts: Record<string, number> = {
            users: 0,
            machinery: 0,
            suppliers: 0,
            rfqs: 0,
            sales: 0,
            reviews: 0,
            service: 0,
          };
          for (const row of activity)
            if (row.date === date) counts[row.kind] = row.count;
          days.push({ date, counts });
        }
        return {
          asOf: asOf.toISOString(),
          timeZone: range.timeZone,
          current,
          activity: { from: range.from, to: range.to, days },
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    ),
};
