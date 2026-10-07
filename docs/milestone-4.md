# Milestone 4 — Supplier and subscription management

> Updated activation rules: the newer supplier-payment brief supersedes the initial manual-only payment boundary below. See [supplier-payment-activation.md](supplier-payment-activation.md) for SSLCOMMERZ, pending supplier accounts and audited manual activation. Existing catalogue/RFQ/sales behavior remains compatible.

M4 builds on M3 using the existing Express controller/service/validation modules, Prisma/PostgreSQL, NextAuth, typed frontend API services and React Hook Form/Zod forms. AloSkill remains unchanged. Suppliers/manufacturers subscribe; buyers do not. Activation is manual and no payment integration is included.

## Setup

Use `milestone-4` in both repositories. Preserve existing environment files and the intended database. With PostgreSQL and Redis running, in `imet-server` run:

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run dev
```

The additive `20261003151953_supplier_subscriptions` migration introduces supplier profiles, plans, subscription history and optional machinery ownership. Existing machinery remains iMet-curated (`supplierId: null`); administrators can explicitly assign ownership later. No suppliers, plans, prices or privileged accounts are seeded.

For public registration, set `PUBLIC_SIGNUP_ROLE=BUYER` in the backend environment. The example now enables this approved workflow; existing `.env` files are preserved and must be updated explicitly. A missing setting still disables registration. Configure `RESEND_API_KEY`, a verified `RESEND_FROM_EMAIL`, and `REDIS_URL` in the backend environment and run `npm run worker` to deliver account verification emails. Redis alone does not deliver email. Never put these credentials in frontend public variables. Existing M1 signing secrets and URL configuration still apply; M4 adds no new environment variables or dependencies.

In `imet-client`, use the existing `.env.local`, run `npm ci` and `npm run dev`. Admin provisioning remains the existing `npm run admin:create` workflow; no default password is supplied.

## Workflow and screens

- `/dashboard/supplier`: application, application status, allowed profile edits, current subscription and history. Active verified registered users may apply. A pending application does not disable their buyer account. A rejected application can be corrected and resubmitted.
- `/dashboard/admin/suppliers`: search/review, approve/reject, verify, suspend/deactivate, visibility, profile edits and manual subscription assignment or renewal.
- `/dashboard/admin/subscriptions`: create/edit/activate/deactivate plans with supplier eligibility, price/currency, duration, listing/image/specification limits, publication permission and visibility.
- `/dashboard/supplier/machinery`: owned machinery management using the existing catalogue editor. Admin catalogue editing includes an explicit supplier-owner selector.
- `/suppliers` and `/suppliers/[id]`: public eligible supplier directory and profiles. Machinery supports supplier filtering and links to the public profile.

Approval grants the appropriate local supplier or international manufacturer role while preserving other roles. Supplier profile identity, type, location, documents, approval and verification are admin-controlled after approval; owners can edit description, contact fields, website and logo. Admin profile edits reset verification. Rejection requires a review reason.

## API

All paths below are under `/api/v1`. Authentication and current database roles/status are enforced by the existing middleware.

| Access | Routes |
| --- | --- |
| Registered user | `GET /supplier/me`, `POST /supplier/applications`, `PUT /supplier/me`, `GET /supplier/plans` |
| Admin suppliers | `GET /admin/suppliers`, `GET /admin/suppliers/:id`, `PUT /admin/suppliers/:id`, `PATCH /admin/suppliers/:id/review` |
| Admin terms | `POST /admin/suppliers/:id/subscriptions`, `PUT /admin/subscriptions/:id` |
| Admin plans | `GET /admin/subscriptions/plans`, `POST /admin/subscriptions/plans`, `PUT /admin/subscriptions/plans/:id` |
| Supplier machinery | `GET /supplier/catalogue/categories`, `GET/POST /supplier/catalogue/machines`, `GET/PUT/DELETE /supplier/catalogue/machines/:id` |
| Public | `GET /suppliers`, `GET /suppliers/:id`, existing `/catalogue` routes |

Edits carry `updatedAt` for optimistic concurrency. Assignments carry `expectedCurrentId` and `expectedCurrentUpdatedAt` (both null for the first term). Stale edits or replacements return 409. Cross-supplier machinery access returns 404. Supplier payloads cannot select another owner or grant approval/verification.

## Subscription behavior

Plans contain admin-entered terms, with no predetermined commercial prices or durations. Assignment requires an approved supplier and an active eligible plan. Each term snapshots the plan's commercial and entitlement fields. Later plan edits or deactivation affect new assignments; existing terms keep their agreed conditions.

Only one current term exists per supplier, enforced by a PostgreSQL partial unique index. Renewing/replacing retires and cancels the prior term without deleting its history. An incompatible lower-limit replacement is rejected before changing the current term. Admins can edit current term state/start/end dates, including suspension, cancellation and extension; replaced terms are immutable.

Dates are UTC instants; frontend local date/time inputs are converted to UTC. End must be after start. The effective status is computed on every request:

1. Manual CANCELLED or SUSPENDED takes precedence.
2. At or after the end instant, the term is EXPIRED.
3. A future start or manual PENDING is PENDING.
4. Otherwise it is ACTIVE (start inclusive, end exclusive).

Expiration does not require a scheduled job. FEATURED supplies a public badge; it does not introduce a paid ranking algorithm.

## Backend enforcement and privacy

Supplier actions require an authenticated active verified owner with the matching role, an approved supplier, and an applicable active current subscription. Publishing also requires supplier marketplace visibility, non-HIDDEN plan visibility and publication permission. Media limits are checked server-side. Listing quota counts all owned records, including drafts. Supplier row locks serialize quota checks and subscription changes; admin-owned listing creation, transfer and publication also enforce supplier eligibility/limits. Admins can unpublish or delete records for cleanup even when a supplier loses entitlement.

Public supplier and owned machinery queries enforce these rules directly, so expiry/suspension hides existing listings without relying on buttons or background updates. Legacy iMet-curated records retain their existing publication rules. Buyer browsing remains subscription-free; RFQ implementation belongs to M5.

Public profiles explicitly whitelist company/type/description/city/country/website/logo/verification/visibility. Business email/phone/contact name, full address, registration number, verification documents, user IDs and subscription price/history are excluded. Private contacts are available only through authenticated owner/admin APIs; M4 does not add a buyer contact-release endpoint.

Logo, machinery media and verification documents use validated HTTPS URLs, following M3's media approach. File upload/storage is not implemented. Private document storage must enforce its own access permissions; hiding a URL in the public API does not make its host private.

## Validation and limits

Backend: schema validation, migration deployment/repeat deployment, lint, type check, build and all 16 tests passed. Tests exercise real database/API workflows, role/ownership/privacy boundaries, stale and concurrent subscription replacement, concurrent quota enforcement, media limits, plan snapshots, renewal, date states, suspension and public visibility. Fixtures are removed after tests.

Frontend: lint, type check and production build passed. Production Chromium checks passed at 390px and 1440px for application, review, plan/term activation, permitted profile edits, publication, public privacy, suspension and restoration; desktop also checked expiry, extension and renewal/history. Development server-component HMR fetch caching is disabled so local testing does not retain stale marketplace responses.

Live Resend delivery and deployment to a production database were not tested. Existing M1 process-local limiter/deduplication limitations and the inherited Prisma tooling audit findings remain. No payment processing, automated approval notifications, RFQ workflow or upload provider is added in M4.
