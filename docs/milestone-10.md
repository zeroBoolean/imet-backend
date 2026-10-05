# Milestone 10 — Service & Warranty

M10 adds after-sales service to existing M6 completed purchases. It preserves catalogue originals, M8 public translations and M9 media. No new dependency, environment variable or worker is required.

## Workflow and permissions

`OPEN → UNDER_REVIEW → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED`

- A verified, active BUYER creates a ticket for their own COMPLETED sale with an existing machinery relation. Buyers need no subscription. Unpublished machinery remains eligible for the existing purchaser. Multiple genuine requests are allowed; a client-generated UUID deduplicates retries.
- Admin reviews, assigns/reassigns, records manual warranty decisions and closes tickets. Assignment is restricted to the original winning sale recipient or an active verified SALES_PERSON; there is no new technician role or unrelated supplier assignment.
- The current assignee starts work with a diagnosis, adds progress and resolves with a required resolution. Admin can perform staff actions. Supplier/manufacturer/independent seller writes require an approved supplier profile and an applicable active subscription; `rfqEnabled` is not required. Expiry retains read-only assigned history. Admin and internal salespeople retain their exemption.
- Customers read their own ticket and public history and add public comments until closure. Internal notes are visible only to admin/current assignee. Reassignment removes the previous assignee's access. Backend checks enforce every permission independently of the UI.
- Requested warranty starts PENDING; admin records APPROVED or DECLINED with an explanation. Requested warranty must be assessed before closure, so a final read-only ticket cannot strand a pending request. This records a manual decision, not automatic coverage, warranty duration, prices, fees or payments.
- Closed tickets are read-only. No reopening/cancellation or automatic notifications are included.

## Data and concurrency

Normalized `ServiceTicket` and `ServiceTicketEvent` refer to existing users, machinery and sales. Restrict foreign keys preserve service history. The additive migration adds enums, tables, indexes and database guards for assignment, resolution, closure and warranty consistency; it does not rewrite earlier records.

Creation derives customer/machinery from the authorized sale rather than client claims. A per-customer/request lock makes identical concurrent submissions idempotent; changed content under the same request ID returns 409. Updates require the last `updatedAt`, lock the ticket and append history in the same transaction. Stale edits return 409 and the UI reloads current data. Read projections exclude prices, private RFQ messages and gated contacts. Pagination counts respect both filters and note visibility.

## API

All paths below are under `/api/v1`, authenticated with existing bearer/session conventions and existing standard responses.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /service-tickets/eligible-purchases | Buyer's eligible completed purchases; optional machine slug/sale ID |
| POST | /service-tickets | Create with saleId, customerRequestId, subject, description, warrantyRequested |
| GET | /service-tickets | Own or assigned tickets; view, search, status, date and ID filters |
| GET | /service-tickets/:id | Authorized detail and action permissions |
| GET | /service-tickets/:id/events | Paginated visibility-filtered history |
| POST | /service-tickets/:id/notes | Public comment or authorized internal progress |
| PATCH | /service-tickets/:id/status | Authorized sequential transition |
| GET | /admin/service-tickets | Admin filtered workspace |
| GET | /admin/service-tickets/:id/assignees | Eligible candidate information |
| PATCH | /admin/service-tickets/:id/assignment | Admin assignment/reassignment |
| PATCH | /admin/service-tickets/:id/warranty | Manual assessment and explanation |

All mutations after creation include `updatedAt`. Inputs use strict Zod schemas, bounded text and UUIDs; list/history limits are at most 50. Creation has an additional 10 submissions/minute per authenticated account, alongside general API protection. Admin detail/status/notes reuse shared authorized endpoints.

## Pages and architecture

- `/dashboard/service-tickets`, `/new`, `/[id]`: buyer request and history.
- `/dashboard/service-management`, `/[id]`: assigned service work.
- `/dashboard/admin/service-tickets`, `/[id]`: review, assignment, warranty and closure.
- Existing completed-purchase and machinery-detail actions preserve sale/machinery context.

The backend follows existing feature routes/controllers/services/validation. Frontend uses existing DashboardShell, primitives, session hooks, typed API client and React Hook Form/Zod conventions, with `ServiceTicketForm`, `ServiceTicketWorkspace` and `ServiceTicketDetailPanel`. Loading, error/retry, empty and stale-edit states are included. No pages were moved and no heavy UI library was added. Private service content stays outside M8 public translation.

## Deployment and validation

From the server checkout, against the intended database:

```sh
npm run db:generate
npm run db:validate
npm run db:deploy
npx prisma migrate status
npm run typecheck
npm run lint
npm run build
npm test
```

M10 has twelve migrations total, including `20261005100000_service_tickets`. Never reset production databases or delete volumes. Repeat deploy reports no pending migrations; schema diff reports no differences. Start the API/client with existing scripts and retain the existing RFQ worker. No service-specific worker is introduced.

Client checks: `npm run type-check`, `npm run lint`, `npm run build`.

Verified: all 72 backend tests passed, zero skipped/failed, including eight focused M10 checks, private-schema migration upgrade preservation of M6/M7/M8/M9 data, retry races, stale mutation races, role/ownership enforcement, private history, reassignment, subscription expiry, manual warranty and closure. Both repositories passed types/lint/production builds. Browser QA exercised the complete real-session lifecycle at 390, 820 and 1440 pixels, including invalid forms, private-note isolation, unauthorized accounts, empty/search states, purchase context and preserved catalogue specifications. Fixtures were isolated and cleaned; no real email or provider request was sent.

## Boundaries

No attachments, automatic warranty policy, service billing, payments, private AI translation, notification/email infrastructure, analytics or enterprise audit dashboard is added. Transactional ticket events provide a future M11/M12 integration point. Existing Bunny/OpenAI credential and headset limitations from M8/M9 remain; M10 requires none of these providers. Live external-provider delivery is not established by local regression tests. M11–M13 are not implemented.
