# Milestone 11 — Notifications

M11 implements the approved **email-only** scope on `milestone-11`. It reuses the AloSkill-aligned iMet Resend/BullMQ/Redis infrastructure. There is no new inbox, notification API, frontend notification page, channel preference, email-language setting or dependency. Existing English emails and M8 en/bn/zh browser content behavior remain intact. M12 is not implemented.

## Architecture

```text
Service business action
  → existing ServiceTicketEvent + unique recipient delivery intent (same DB transaction)
  → existing minute RFQ-maintenance worker dispatches committed intents
  → existing BullMQ email queue
  → existing email worker refreshes recipient authorization/content
  → existing ResendProvider
```

Core requests never call Redis or Resend for service notification delivery. The database commits ticket/event/intents together; Redis/provider failures are handled later and do not turn a successful ticket action into a failed response. A database transaction failure remains a genuine failure of that transaction. Authentication uses its existing queued MailService flow. RFQ retains its existing event/recipient intents and trigger rules; dispatch shares the new reliable delivery helper.

AloSkill's reusable pattern is mail service/templates → queue → worker/provider. Its static broadcast UI, push/marketing controls, loose typing and unrelated payment notification types were not copied.

## New service events and recipients

| Existing M10 event | Email recipients |
| --- | --- |
| TICKET_CREATED | Customer acknowledgement; active verified admins for review |
| TICKET_UNDER_REVIEW | Customer |
| TICKET_ASSIGNED | New/current assignee and customer |
| TICKET_IN_PROGRESS | Customer |
| TICKET_RESOLVED | Customer |
| TICKET_CLOSED | Customer |
| WARRANTY_ASSESSED | Customer |

Creation acknowledgement is intentional even though the customer is the actor. Other self-action notifications are suppressed. Assignee eligibility is rechecked against the current assignment at dispatch and immediately before provider delivery; previous assignees do not receive queued assignment mail after reassignment. Active/verified account and current role/resource access are required. Supplier write entitlement is not required merely to receive/read assigned history; M10's active-subscription requirements for changes remain intact.

Internal notes, public progress/comments, private service descriptions, diagnoses, resolution text, warranty explanations, private RFQ messages, prices and contacts are not included in emails. A message contains an event label, stable SVC reference, recipient greeting and an authorized workspace link. Warranty mail says assessment occurred; it does not claim automatic coverage or payment.

No new standalone M4 subscription, M6 sale-record or M7 review emails are added. Normal translation/media operations do not notify. Existing RFQ authentication, routing, subscription and business rules remain intact.

## Existing notifications preserved

Verification, verification resend and password reset use the same auth flows and queue. Plain-text alternatives now accompany existing authentication HTML.

Existing RFQ delivery intents remain associated with their original events/recipients: submission/routing/assignment, quotes and acceptance, lead decline, messages, cancellation/closure/expiry/reminders, recipient removal/rerouting, flag changes and explicit admin resend. Events without recipients still do not generate email. Auth/provider failure masking and existing action/general rate limits remain in place.

RFQ emails now refresh authorization and omit the private request title. Removed lead recipients are suppressed except the intentional RECIPIENT_REMOVED notice, which links to the lead list rather than an inaccessible detail page. Existing buyer/lead/admin deep-link conventions remain, with authorization enforced on navigation.

## Database and migration

`20261005120000_notification_delivery` is additive; thirteen migrations total.

- `NotificationEmailDelivery` relates to existing ServiceTicketEvent and User. It stores delivery state, bounded dispatch/provider attempts, first provider-attempt time, provider ID, dispatch lease, safe error summary and timestamps. It has unique(eventId,userId) and a status/createdAt/id dispatch index. No duplicated email/user data, private content or arbitrary metadata JSON is stored.
- Event deletion cascades its derivative delivery records; existing service-event restrictions still preserve ticket history. Recipient deletion is restricted while a delivery record exists.
- Existing `RfqEmailDelivery` receives provider attempt/time/ID and dispatch-lease columns. Existing rows and unique keys are retained. Previously QUEUED rows initialize the conservative retry boundary from queuedAt; old SENT rows are never resent merely because they lack a provider ID.
- The existing RfqEmailStatus enum is reused and gains SUPPRESSED and REVIEW_REQUIRED. PENDING, QUEUED, SENT and FAILED retain their meanings. SENT means Resend accepted the request, not that an inbox received it. No webhook or delivery analytics is claimed.
- Database guards bound provider attempts to five and new service dispatch attempts to five.
- Historical pre-M11 service events are not replayed; no historical notification flood.

## Delivery, retries and recovery

Both intent dispatchers use bounded 100-record batches. Database leases coordinate concurrent maintenance processes without holding a transaction over Redis. Stable delivery IDs are queue job IDs and Resend idempotency keys. Terminal updates cannot be overwritten by a late QUEUED/FAILED dispatcher update.

The existing queue retries with exponential backoff, five attempts, and worker concurrency five. Durable rows cap provider calls at five across retries/requeues; queue dispatch failures also consume a bounded budget. Interrupted QUEUED records are checked after five minutes. Missing jobs can be recreated safely; retained completed job results reconcile accepted provider IDs without resending. Failed queue jobs can be retried only while the durable budget allows it. Known successful job results are retained so a database bookkeeping failure after provider acceptance is recoverable.

Resend idempotency has finite retention. A previously attempted delivery outside a conservative 23-hour retry window becomes REVIEW_REQUIRED instead of being automatically resent. There is no exactly-once-delivery guarantee for ambiguous external failures beyond the provider's retention window.

FAILED after exhausted attempts and REVIEW_REQUIRED need operator investigation. Check the retained BullMQ job result/provider record first. Do not blindly delete jobs/reset attempt counters or retry an old ambiguous provider request. Existing RFQ admin resend creates a new, intentional event; M11 adds no service resend/broadcast endpoint. Error text is generic and does not contain provider payloads, credentials or private content.

## Email content and languages

`serviceEmail.ts` supplies consistent branding, event subject/preheader, responsive HTML, CTA and plain text. `escapeHtml.ts` is reused across templates. Authentication and RFQ templates now include text alternatives. Untrusted names are HTML-escaped; URLs come from existing server FRONTEND_URL and allowlisted route construction. IDs, reference numbers and technical identifiers are unchanged.

The approved email language is English. M8 public translation/content selection remains en/bn/zh and is unchanged. No AI call translates private notifications; there is no inferred server preference from browser storage or an RFQ's preferred language.

## Files and API/frontend scope

New backend files:

- `src/modules/notification/notification.service.ts`: approved event recipients, current authorization and safe content/deep links.
- `src/modules/notification/notification.jobs.ts`: shared durable dispatch, retry/recovery and provider delivery.
- `src/emails/templates/serviceEmail.ts`, `escapeHtml.ts`.
- Additive Prisma migration and notification/migration tests.

Modified backend: Prisma schema; M10 event helper; existing RFQ dispatcher/maintenance worker; email queue/worker/Resend adapter/MailService; authentication/RFQ templates and provider test. No controller/business route/API contract is added or changed.

Frontend runtime files are unchanged for this email-only milestone. The matching client branch updates this guide/README and preserves all M0–M10 pages, forms, toasts/local notices and language controls. Persistent read state, unread counts and mark-read controls are intentionally not implemented because they were not selected.

## Setup and deployment

Use existing checkouts without creating a worktree. Preserve environment files and database volumes. No new environment key is needed. From the backend, against the intended database:

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

Restart **both existing workers** after deployment so the changed shared delivery logic and maintenance dispatch run together. Production processes:

```sh
# Separate persistent sessions in imet-server:
npm start
npm run worker:rfq:prod
npm run worker:prod
# Separate session in imet-client, after its normal build:
npm start
```

For development, use dev / worker:rfq / worker equivalents. PostgreSQL and Redis must be healthy. The RFQ-maintenance worker dispatches service intents as well as RFQ intents; it does not require Resend credentials. Actual provider delivery requires **RESEND_API_KEY** and **RESEND_FROM_EMAIL** (a verified sender) in backend environment settings. Never place keys in the client or chat. FRONTEND_URL supplies workspace link origins. Do not claim API database readiness establishes email-worker/provider readiness.

## Validation and remaining limits

Verified: both repositories passed type checks, lint and production builds. All **82 backend tests passed**, zero failed/skipped, including ten focused M11 checks. Tests cover the complete real-API service lifecycle and exact recipients, idempotent API/event replay, private-note exclusion, reassignment, account revocation, Redis failure isolation, concurrent dispatch, queued-job recovery, stable-key worker retries, bounded/old ambiguous attempts, completed-job reconciliation, authentication compatibility, RFQ privacy/deep links, HTML/text safety and additive migration preservation. Existing M0–M10 regression suites remain green.

Production browser regression passed 390/820/1440 pixel layouts for customer creation, admin review/assignment/warranty, assignee public/private progress/resolution, admin closure, authorization, empty/search states, purchase context and preserved machinery specifications. No notification UI was introduced. Isolated QA records/queues were cleaned and normal API/client/RFQ maintenance restored; actual Redis maintenance and database readiness were checked.

Resend credentials and sender were absent in this environment. The normal email worker correctly refused startup for that missing configuration. Provider payload/error tests and queue delivery tests used mocks; no real customer email was sent. Configure the existing secure Resend settings and start the email worker to enable live delivery. Live inbox receipt, sender-domain deliverability and provider webhooks are not verified. Earlier M8/M9 external-provider/headset limitations remain unchanged.

No persistent inbox, SMS, WhatsApp, push, marketing, payments, notification analytics/audit or M12 feature is implemented.
