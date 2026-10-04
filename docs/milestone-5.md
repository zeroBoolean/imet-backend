# Milestone 5 — RFQ & Lead Management

M5 extends the M0–M4 Express modules, Zod validation, Prisma transactions, authenticated dashboard and existing BullMQ/Resend setup. It adds no payment or in-app notification subsystem. AloSkill references remain unchanged.

## Business rules

- Buyers create/edit drafts, attach documents, submit, cancel before acceptance, accept/reject private quotes and close accepted requests. Buyer subscriptions are not required.
- Machine requests route to the machine owner. Category requests route to approved, visible suppliers with published machinery in that category, optionally filtered by country. General/unmatched requests route to active verified salespeople. Salespeople can respond or add eligible recipients to their own assigned RFQs; admins can reroute, add/remove recipients, flag, cancel or force close.
- An approved supplier profile, matching supplier role and applicable active subscription with `rfqEnabled` are required for suppliers/manufacturers/sellers to receive/respond to leads. `leadLimitPerMonth` is admin-defined: zero disables allocation, null means unlimited. Usage counts allocations in UTC calendar months, including removed recipients; renewal does not reset usage. Supplier row locks serialize concurrent allocation. Reassigning the same RFQ does not charge it twice.
- Subscription assignments snapshot RFQ permissions. Existing M4 terms remain RFQ-disabled after migration. Edit/create a plan, then renew/assign it to enable M5; changing a plan does not silently change current terms.
- Competing quotes and per-recipient messages are private. Budget is returned only to the buyer/admin. Contact is returned only for the accepted recipient, while its approved/current active subscription permits contact reveal, its user is active/verified, and neither RFQ nor supplier contact is blocked. Losing recipients cannot see contact. Recheck occurs on every request, including after closure.
- Submitted, routed or quoted requests expire after 14 days by default; acceptance stops expiry. Reminder goes to unresponsive NEW/VIEWED leads 2 days before expiry. All recipients declining marks the RFQ DECLINED. Terminal requests cannot be reopened through ordinary actions.
- Versioned mutations require the latest ISO `updatedAt`; stale/conflicting operations return 409. RFQ row locking and a partial unique index prevent two accepted quotes.

## Setup

Use Node 24+ and PostgreSQL/Redis from the existing setup:

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run dev
```

Two additive migrations create the RFQ models, relations, private attachment metadata, audit events, durable email delivery records, entitlements and integrity constraints. No plan prices, quotas or privileged accounts are seeded.

Configure these **server-side only** in `imet-server/.env` locally or the backend host's environment settings:

```dotenv
RFQ_EXPIRY_DAYS=14
RFQ_REMINDER_DAYS=2
BUNNY_STORAGE_ZONE=your-private-storage-zone-name
BUNNY_STORAGE_HOST=storage.bunnycdn.com
BUNNY_STORAGE_ACCESS_KEY=your-zone-storage-password
RESEND_API_KEY=your-resend-key
RESEND_FROM_EMAIL=iMet <verified-sender@your-domain>
```

Do not commit real keys or put Bunny/Resend credentials in `imet-client`, NEXT_PUBLIC variables, attachment URLs, or chat. Use the Bunny **Storage Zone password**, not the account API key or read-only password; select the matching regional hostname supported in `src/config/env.ts`. Keep this zone private: do not connect a public CDN pull zone. The backend alone performs PUT/GET/DELETE with the AccessKey header.

Run both workers as separate persistent processes, with the same backend environment/database/Redis settings:

```sh
npm run worker
npm run worker:rfq
```

Production equivalents: `npm run worker:prod` and `npm run worker:rfq:prod` after `npm run build`. The existing email worker sends mail; the RFQ worker schedules minute-by-minute expiry/reminders and dispatches durable database email intents to that queue. Stable delivery IDs provide queue/provider idempotency. Failed delivery dispatch is bounded; admin resend creates a new audited intent. SENT means the provider accepted delivery, not inbox receipt. Monitor FAILED/PENDING records and worker logs. Redis outages do not discard transactional intent.

Missing Bunny configuration returns 503 for uploads without affecting text RFQs. Missing Resend configuration prevents the mail worker from starting. No live external delivery is asserted by tests using mocks.

## Routes and screens

All APIs use the existing `/api/v1` prefix and response envelope.

- `/rfqs`: buyer create/list, `/:id` role-aware detail/draft edit; `submit`, `cancel`, `close`, `quotes`, `messages`, `recipients`.
- `/leads`: recipient inbox/detail plus `viewed` and `decline`. Lead IDs are recipient-row IDs; RFQ IDs identify requests.
- `/quotes`: paginated own quotes; `/:id` edit; `withdraw`, `accept`, `reject`.
- `/admin/rfqs`: all requests/detail and `reroute`, `recipients`, `close`, `cancel`, `flag`, `resend-notifications`.
- `/admin/leads`: paginated/searchable supplier counts, response rates, monthly caps/usage.
- `/rfq-options/categories`, `/rfq-options/recipients`: authenticated pickers; recipient/buyer search restricted appropriately.
- `POST /rfqs/:id/attachments`, `POST /quotes/:id/attachments`: multipart `file`, at most 10 files per request/quote, each at most 10 MiB, content-detected PDF/PNG/JPEG only. Files are private storage keys, never public links. Download through authenticated `/rfq-attachments/:id` or `/quote-attachments/:id`; ownership/assignment checks run before reading storage, with bounded buffering and no-store/nosniff headers. Attach while RFQ is DRAFT or quote is PENDING/open. Upload bytes are not logged. A failed DB write attempts storage cleanup.

Frontend: `/dashboard/rfqs`, `/dashboard/rfqs/new`, `/dashboard/rfqs/:id`, `/dashboard/leads`, `/dashboard/leads/:id`, `/dashboard/quotes`, `/dashboard/admin/rfqs`, `/dashboard/admin/rfqs/:id`, `/dashboard/admin/leads`. Machinery detail and general navigation link to RFQ creation. Existing plan editor exposes RFQ access, monthly caps and post-acceptance contact permissions.

## Verification

Run `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, `npm run db:validate`, and repeat `npm run db:deploy` on the intended test database. Tests create/delete isolated fixtures. Frontend: `npm run lint`, `npm run type-check`, `npm run build`.

`tests/rfq.test.ts` exercises authenticated routing, role/ownership/privacy, budgets and messages, monthly caps under concurrent RFQ submissions, concurrent winner selection, current contact blocking, closure/expiry idempotency, audit/email intents, content detection and private upload/download against mocked Bunny HTTP. Existing M0–M4 tests remain required.

Before deployment, configure real secure Bunny and Resend credentials, verify an authorized end-to-end attachment transfer and recipient email delivery, and keep both workers running. File signature checks are not antivirus scanning. Storage objects and audit/email records require an operational retention policy; the MVP never exposes objects publicly or deletes audit history automatically.

## Implementation validation (2026-10-04)

Both repository production builds, lint and TypeScript checks passed. Backend regression suite: 18 tests passed, including M0–M4 and M5. The final RFQ integration rerun also checked archived thread access and paginated lead overview. Prisma validation and repeat migration deployment passed.

Browser flow passed against running production builds: buyer creates/submits a machinery RFQ; supplier marks viewed and quotes; buyer compares, accepts, sees gated contact and closes; admin audit renders. RFQ list/detail, leads, quotes, admin RFQs and lead overview passed at 390/820/1440 pixels without horizontal overflow or application error alerts. All temporary records were cleaned up.

Live Bunny transfer and Resend delivery remain unverified because provider credentials are absent. Private Bunny HTTP was mocked in integration tests; email provider payload/error behavior was mocked in the existing regression suite. Environment configuration draft includes M5 worker startup and missing Bunny requirements; it still needs secure values and publication through environment settings.
