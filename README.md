# iMet Machinery API — Milestone 0

AloSkill-aligned Express 5 / TypeScript backend with PostgreSQL and Prisma 7.

## Setup

Use Node.js 24 and npm 11. The cloud task is already isolated; use this checkout directly without creating a worktree.

```sh
cd /workspace/imet-server
# Preserve an existing local environment file.
test -e .env || cp .env.example .env
npm ci --cache /workspace/.npm-cache
docker compose up -d --wait
npm run db:validate
npm run db:generate
npm run dev
```

The Compose credentials are public development-only defaults. Ports bind to loopback. Use a separate database and secure credentials for any deployment. `DATABASE_URL` is a server-only PostgreSQL connection string; never expose it through a public frontend variable.

## Structure

- `src/app.ts`: Express setup, security, routes, and errors.
- `src/server.ts`: startup with an actual database query and graceful shutdown.
- `src/modules/<feature>/`: feature routes, controllers, services, and validation as required.
- `src/config/`: validated environment and Prisma adapter/client.
- `src/middleware/`: security, schema validation, and errors.
- `src/utils/`: async controllers and response helpers.
- `src/types/`: API contracts.
- `prisma/`: schema and future reviewed migrations.

The Prisma schema intentionally contains no business models. M0 creates no application tables or seed users. Authentication models belong to M1. Use `npm run db:migrate -- --name <change>` when implementing a reviewed schema change, commit its migration, and use `npm run db:deploy` for deployment. Do not use `db push` as the production migration workflow. Prisma generation does not apply migrations.

## API

- `GET /health`: process liveness; does not establish database readiness.
- `GET /api/v1/health`: readiness; queries PostgreSQL and returns 200 or 503.
- Unregistered routes: 404 with the standard response.

Responses contain `success`, `message`, `timestamp`, and optional `data` or `errors`. Validation issues use `{ path: string[], message: string }`. Validation middleware places parsed/transformed input in `res.locals.validated`; controllers must consume that value instead of raw request input. Unexpected errors are masked. The configured frontend origin receives CORS headers; CORS is not authentication or authorization.

No authentication, marketplace, subscription, RFQ, translation, upload, or transactional email endpoint is implemented in M0.

## Email preparation

Redis is available for the later AloSkill-style BullMQ worker. M1 will introduce Resend, templates, and queued authentication emails. Configure `RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` securely then; neither is required to run M0. Redis authentication/TLS must be configured for a remote instance. Payment gateway and Google OAuth credentials are not required.

## Validation

```sh
npm run typecheck
npm run lint
npm run build
npm test
```

Tests require the development database. They verify real database readiness, malformed JSON, 404 responses, CORS/security headers, schema transformations, and field errors. The frontend README describes the companion application.

`docker compose down` stops local services while retaining volumes. Avoid `down -v` unless intentionally deleting development data.

## Milestone 1 authentication

See [the M1 report](docs/milestone-1.md) for current endpoints, signup-policy gating, secure configuration, email worker startup, migration and testing details. Run `node scripts/init-local-env.mjs` before starting M1 to initialize missing development signing secrets without overwriting existing values. Apply the reviewed authentication migration with `npm run db:deploy`. Public signup is disabled while policy approval is pending.

## Milestone 2

The `milestone-2` branch includes public catalogue APIs and an additive Prisma migration. Apply it to the intended database with `npm run db:deploy`. See [Milestone 2](docs/milestone-2.md) for API contracts, publication rules, validation and deferred features. No sample records are published automatically.

## Milestone 3

The `milestone-3` branch adds admin-only catalogue management APIs. See [Milestone 3](docs/milestone-3.md) for routes, payload limits, publication behavior, optimistic machine edits/deletes and setup. It reuses the existing schema and has no new migration or environment variables.

## Milestone 4

The `milestone-4` branch adds supplier applications/admin approval, public supplier profiles, admin-defined plans, manual subscription terms/history and backend-enforced supplier machinery entitlements. Apply the additive migration with `npm run db:generate` and `npm run db:deploy`. Existing environments must set `PUBLIC_SIGNUP_ROLE=BUYER` for registration and retain the M1 Resend/Redis worker configuration for email verification. See [Milestone 4](docs/milestone-4.md) for setup, routes, privacy, quota and renewal rules. No payment processing is included.

## Milestone 5

RFQ lifecycle, recipient routing, private quotes/messages, subscription lead caps, contact gating, admin intervention, private Bunny attachments and BullMQ email/expiry jobs are documented in [docs/milestone-5.md](docs/milestone-5.md). Run both the email and RFQ workers. Live transfer/delivery requires secure provider credentials.

## Milestone 6

Private recipient-owned sales pipelines, manual records from accepted M5 quotes, final completion/cancellation, buyer read-only purchases and admin oversight are documented in [docs/milestone-6.md](docs/milestone-6.md). Apply the additive migration using `npm run db:deploy` before starting the matching frontend. Supplier history survives subscription expiry; backend mutations still require active RFQ entitlement. No new provider, environment variable, dependency or payment integration is introduced.

## Milestone 7

Completed-sale buyer reviews, admin approval/moderation, public ratings and a homepage driven by current catalogue/supplier/plan/review data are documented in [docs/milestone-7.md](docs/milestone-7.md). Apply the additive review migration with `npm run db:deploy`. No new provider, dependency or environment variable is required. The database test files now run sequentially while concurrent API race tests remain enabled.

## Milestone 8

See [AI Translation](docs/milestone-8.md) for approved public content, admin generation, original-safe caching, OpenAI configuration and deployment/test evidence. Apply the additive migration and configure `AI_TRANSLATION_API_KEY` securely on the server for live cross-language generation.

Milestone 9 adds secured machinery media uploads/delivery with durable recovery states. See [M9 setup, API and validation](docs/milestone-9.md). Deploy both additive M9 migrations and configure the existing Bunny storage zone/key on the backend; never make private RFQ storage public.

## Milestone 10 — Service & Warranty

The `milestone-10` branch adds completed-purchase service tickets, admin review/assignment/manual warranty assessment, assignee progress/resolution and admin closure. Read [the M10 implementation and deployment guide](docs/milestone-10.md) for permissions, APIs, pages, migration and validation. No new provider, dependency or environment variable is required.

## Milestone 11 — Notifications

The `milestone-11` branch adds durable, email-only service notifications through the existing Resend/BullMQ infrastructure and shared RFQ delivery recovery. See [M11 setup, event recipients and verification](docs/milestone-11.md). Apply the additive migration and restart the API and both existing workers. Live delivery needs the existing backend Resend key and verified sender; there is no inbox or new dependency.
