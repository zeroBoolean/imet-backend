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
