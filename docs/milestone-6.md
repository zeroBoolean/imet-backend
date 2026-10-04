# Milestone 6 — Seller & Sales Management

M6 builds a private sales pipeline on the existing M5 recipient/lead, quote and RFQ workflows. Use matching `milestone-6` branches in both repositories. It includes the M5 functionality and the frontend UI redesign.

## Confirmed business rules

The supplied M6 brief and original uploaded master prompt did not specify ownership or an exact lifecycle. The user confirmed:

- One private opportunity per existing M5 recipient/lead. The assigned supplier, manufacturer, independent seller or internal salesperson owns it; administrators oversee all opportunities.
- Stages: `NEW → QUALIFIED → QUOTED → NEGOTIATION → WON / LOST`.
- Manual sale recording by the winning recipient or administrator after an accepted M5 quote. Acceptance alone never creates a sale record.
- Sale states: `RECORDED → COMPLETED` or `RECORDED → CANCELLED`. Completed and cancelled records are final.
- Buyers can read their own sale records, without a subscription. They cannot edit sales or read private opportunities, internal notes or sales activity.
- Supplier subscription expiry preserves read-only history. Supplier mutations require an approved profile, matching supplier role and applicable active RFQ-enabled subscription. Internal salespeople and administrators retain their existing exemptions.

Qualification is a private stage change from New. Existing quote submission sets Quoted, including direct submission without qualification. A recipient may enter Negotiation from Quoted only with a pending, unexpired quote on an open RFQ. Buyer acceptance sets the winner to Won and competitors to Lost. RFQ cancellation/expiry, unsuccessful closure, lead decline and removal set the applicable opportunities to Lost. Accepted winners remain Won when their RFQ is closed.

There is no direct manual backward stage edit, arbitrary Won/Lost override or reopening of a final sale. Existing explicit M5 admin/salesperson reassignment may restore a removed assignment while an RFQ is open; its existing opportunity is reused and its resulting stage change is recorded as an M5 outcome. This preserves M5 routing behavior rather than creating a second assignment system.

Cancellation of a sale records a buyer-visible reason; it does not reverse the accepted quote, change the Won stage, process a refund or alter the RFQ.

## Database and migration

`prisma/migrations/20261004120000_sales_management/migration.sql` is additive:

- `SalesOpportunity`: unique M5 recipient FK, stage, private internal notes, timestamps and stage/activity index.
- `SaleRecord`: unique opportunity and accepted-quote relations, recording administrator/recipient, status, cancellation reason and terminal timestamps.
- `SalesEvent`: private opportunity activity with nullable actor and metadata; no new notification or reporting framework.
- `SalesStage` and `SaleStatus` enums, inverse relations and composite unique constraints.

Composite foreign keys ensure that the opportunity and accepted quote belong to the same recipient. Unique constraints prevent duplicate recording. Restrict deletion protects sales history. A SQL check constrains terminal timestamps and cancellation-reason presence.

Existing M5 recipients are backfilled into opportunities with stages derived from their quote/RFQ/assignment outcomes. Each gets an import event. Existing RFQs/quotes remain unchanged; existing accepted quotes get no automatic sale record. No database reset, commercial seed or account seed is needed.

Pricing comes from the immutable accepted M5 quote and submitted RFQ quantity. There are no editable duplicate commercial fields. Responses derive quantity × accepted unit price using precision-40 Decimal arithmetic; money remains strings and is never converted through floating-point or a currency conversion. The displayed total is quoted value, not a payment or a tax/shipping invoice.

## Backend API

All routes are below `/api/v1`, use existing session/current-account authentication, role checks, strict Zod validation, response envelopes and route/controller/service/Prisma conventions.

| Method | Route                                   | Access / behavior                                                          |
| ------ | --------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/sales/opportunities`                  | Recipient's own pipeline, search, stage counts, dates, sorting, pagination |
| GET    | `/sales/opportunities/:id`              | Owner or admin; private requirements, own quotes, notes and activity       |
| PATCH  | `/sales/opportunities/:id`              | Owner or admin; qualification/negotiation and/or internal notes            |
| POST   | `/sales/opportunities/:id/record-sale`  | Winner or admin; manual recording from accepted quote                      |
| GET    | `/sales/records`                        | Seller history; `view=buyer` scopes to requesting buyer's RFQs             |
| GET    | `/sales/records/:id`                    | Assigned seller, owning buyer or admin; accepted commercial terms only     |
| PATCH  | `/sales/records/:id`                    | Seller or admin; completion/cancellation                                   |
| GET    | `/admin/sales/opportunities` and `/:id` | Admin oversight across recipients                                          |
| GET    | `/admin/sales/records` and `/:id`       | Admin oversight across records                                             |

Mutation bodies require the last `updatedAt` ISO version. Opportunity updates accept only `QUALIFIED`/`NEGOTIATION` and/or `internalNotes` (5,000 characters). Recording accepts only the opportunity version, with no pricing override. Sale changes accept `COMPLETED`/`CANCELLED` plus cancellation `reason` (1–2,000 characters). Search is limited to 100 characters; pages contain at most 50 records. Date filters apply to creation time. Stable ID tie-breakers support sorting.

Every mutation serializes on the same RFQ row used by M5, re-reads records, checks ownership/version and rechecks entitlements under the existing supplier lock. Concurrent saves/recording yield a conflict rather than lost updates or duplicate records. Read-only capability hints are returned for the UI; backend checks remain authoritative. Flagged RFQs pause changes, including administrator changes. Removed recipients keep private read history but cannot change it.

Public catalogue/contact APIs are untouched. New explicit projections exclude private supplier contacts, buyer email and RFQ budget. Competing quotes never appear in a recipient's opportunity. Buyer sale projections exclude pipeline notes, private events and subscription details. Knowing an opportunity ID from a sale grants no access to that opportunity.

## Frontend

Reuses the existing dashboard shell, role layouts, NextAuth session, Bearer API service, Tailwind styles, PageHeader, Button, Badge, LoadingState and EmptyState. New forms use existing React Hook Form/Zod conventions. No new dependency or architecture was introduced.

- Recipient `/dashboard/sales`, `/dashboard/sales/[id]`.
- Recipient `/dashboard/sales/history`, `/dashboard/sales/history/[id]`.
- Admin `/dashboard/admin/sales`, `/dashboard/admin/sales/[id]` and matching history routes.
- Buyer `/dashboard/purchases`, `/dashboard/purchases/[id]` (read-only).

The pipeline provides compact stage counts, requirement cards, title/RFQ search, stage/date filters, sorting and pagination. Opportunity details connect to existing lead quotes/conversation or admin RFQ controls. Private notes and activity remain separate from buyer-visible quotation terms. History cards display exact totals, currency and status without a wide mobile table. Subscription restrictions visibly disable editing and explain read-only history. Loading, empty, error/retry, stale-record reload and successful action feedback are included, with labelled forms and existing keyboard focus styles.

## Setup

No new environment variable, dependency or worker is required for M6. Keep M1–M5 PostgreSQL/Redis, authentication, Bunny and Resend configuration.

```bash
# imet-server, against the intended database
npm ci
npm run db:generate
npm run db:validate
npm run db:deploy
npm run build
npm start

# imet-client
npm ci
npm run build
npm start
```

Continue running `npm run worker:rfq` (or `worker:rfq:prod`) for M5 RFQ expiry/reminders, and the existing Resend email worker when securely configured. Expiry changes opportunities in the same transaction. M6 does not add email delivery. Provider credentials belong only in backend/environment settings; no live external transfer/delivery is implied by mocked tests.

## Validation

- Backend lint, typecheck, build, Prisma validation, migration status and schema diff.
- Existing authentication/catalogue/supplier/subscription/RFQ regression suite plus M6 HTTP integration tests for full lifecycle, privacy, ownership, strict inputs, expired/suspended/disabled entitlements, admin/salesperson exemptions and concurrent mutations.
- Migration test applies the previous migrations in a private PostgreSQL schema, adds representative M5 records, upgrades and checks unchanged RFQs, backfilled stages, duplicate protection, composite FKs and terminal-date guards. The transaction is rolled back without touching application data.
- Browser validation uses temporary buyer/supplier/admin accounts, starts with real M5 RFQ creation/quotation/acceptance, exercises private qualification/notes/negotiation/manual sale recording/completion/cancellation and checks buyer privacy, read-only subscription UI, filters, loading/empty/error/retry and responsive layouts.

Validated results: all **29 backend tests passed** (no skipped tests); both lint/typecheck/build workflows passed; Prisma schema validation, deployed migration status and live schema diff passed. Browser flow and all ten M6 pages passed at 390/820/1440 pixels. Mobile stress testing also checked large exact totals and unbroken quotation text. Temporary accounts, sales/RFQ fixtures and migration schemas were removed. Live Bunny transfer and Resend delivery remain dependent on the existing secure provider configuration.

Only M6 is implemented. No payment, commission, duplicate lead/quote/message/upload system, or M7–M13 feature is added. The confirmed user decisions resolve the ownership/lifecycle ambiguity; no further M6 decision is pending.
