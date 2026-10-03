# Milestone 1 — Authentication & User Management

## Status and decisions pending

Authentication and account-management code is implemented on `milestone-1`. Public signup is deliberately disabled unless `PUBLIC_SIGNUP_ROLE=BUYER` is explicitly configured. The user has been asked whether signup should create Buyer accounts only, or allow business-role signup with admin approval. No business-role self-registration/approval policy has been invented. The Buyer configuration used in tests is a fixture, not a production decision. Business role assignment is restricted to administrators.

Resend credentials and a verified sender are absent in the current environment. Redis queueing and the Resend adapter are tested; actual Resend delivery remains unverified. Do not declare M1 fully operational until signup policy is confirmed and transactional email works with the configured sender. Do not continue automatically to M2.

## Architecture

AloSkill-style NextAuth credentials sessions, React Hook Form/Zod forms, App Router auth/account routes, backend feature modules, centralized error responses, PostgreSQL/Prisma, and Redis/BullMQ/Resend email worker. NextAuth is patched to 4.24.15 following dependency auditing. No Google OAuth, payment, marketplace, subscriptions, or supplier approval workflow is introduced.

Passwords use Argon2id. Verification and reset tokens are random, hashed, expire after one hour, and are consumed atomically. Refresh tokens are opaque, SHA-256 hashed, rotate atomically, and expire after seven days without sliding renewal. JWT access tokens expire after 15 minutes, include session/user identifiers, and restrict algorithm/issuer/audience. Every protected request checks current session revocation/expiry and current user status, verification, and assigned roles in PostgreSQL. Reset/change/logout-all revoke existing sessions. The frontend never stores tokens in localStorage; refresh tokens remain inside the server-managed NextAuth JWT cookie and are excluded from browser session responses. Backend permission checks remain authoritative.

## Database

Migration `20261003085308_authentication_user_management` creates `users`, `user_role_assignments`, and `user_sessions`; UUID identities, unique emails/token hashes, timestamps, and indexed account/session lookups. No default accounts or passwords are seeded.

Roles: BUYER, LOCAL_SUPPLIER, INTERNATIONAL_MANUFACTURER, SALES_PERSON, INDEPENDENT_SELLER, ADMIN. Account statuses: ACTIVE, INACTIVE, SUSPENDED, PENDING_VERIFICATION. A verified, active administrator can assign roles and update other accounts. Unverified accounts cannot be activated by the admin API. Self-access changes are rejected; serializable transactions guard against removal of the final active admin. Status/role changes revoke target sessions.

## API

All paths are under `/api/v1`:

- POST `/auth/register`: configured signup policy only; rejects extra role/status fields.
- POST `/auth/login`, `/auth/refresh`.
- POST `/auth/verify-user`, `/auth/resend-verification`.
- POST `/auth/forgot-password`, `/auth/reset-password`.
- GET `/auth/me`.
- POST `/auth/change-password`, `/auth/logout`, `/auth/logout-all`: authenticated.
- PATCH `/user/me`: own display name only.
- GET `/user?page=1&limit=20`: administrator-only paginated account list.
- PATCH `/user/:id`: administrator-only status/role management.

Registration/resend/forgot responses do not disclose account existence. Requests validate field types/lengths and matching passwords. Login and email requests have rate limits. Known operational errors use safe public messages; unexpected errors are masked. No request credentials, token links, or authorization headers are logged.

## Frontend

`/auth/signup`, `/auth/signin`, `/auth/verify-user`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`; protected `/dashboard/account` and administrator `/dashboard/admin/users`. Forms provide field errors, submitting/disabled states, success/failure messages, labels, and responsive layouts. Account page supports profile editing, password change, logout, and logout-all. Server layouts and APIs verify access independently of visible UI.

## Configuration and startup

```sh
cd /workspace/imet-server
npm ci --cache /workspace/.npm-cache
node scripts/init-local-env.mjs
# Inspect/preserve your database configuration before applying migrations.
docker compose up -d --wait
npm run db:deploy
npm run dev
# Separate persistent session, after configuring Resend:
npm run worker
# Separate persistent session:
cd /workspace/imet-client
npm ci --cache /workspace/.npm-cache
npm run dev
```

Signing secrets `JWT_SECRET` and `NEXTAUTH_SECRET` must be independent, securely generated, persistent, and at least 32 characters. The local helper preserves existing files/bindings and generates only missing development signing keys without displaying them. For deployment supply secure values through your secret manager. `NEXTAUTH_URL` and backend `FRONTEND_URL` must match the frontend origin; use HTTPS in production. Existing development files and keys are ignored by Git.

Email worker needs `RESEND_API_KEY` and a verified email address in `RESEND_FROM_EMAIL`. The cloud draft declares these requirements and permits `api.resend.com`. Configure Redis authentication/TLS for a remote instance. Auth links contain sensitive single-use tokens; email jobs are removed on completion and failed jobs retained for at most one day/100 jobs. Keep Redis private. A queued job is not evidence of delivered email. The worker fails closed when sender/key are missing; API registration can queue while delivery is unavailable. After fixing a queue/provider outage, use resend verification to recover a pending account.

Initial admin provisioning is explicit: provide `ADMIN_EMAIL`, `ADMIN_NAME`, and `ADMIN_PASSWORD` securely, run `npm run admin:create`, then remove those temporary bindings. No privileged credentials are included in repository files; the script never overwrites an existing account.

## Validation and limits

Backend tests exercise registration with a Buyer fixture, email verification, reset/change password, rotation/replay rejection, logout/all-session revocation, account restrictions, admin-only access, profile editing, Redis queue links, malformed requests, readiness, and safe errors. Resend adapter tests mock HTTP responses and verify payload/idempotency/error behavior; they do not establish external email delivery. Browser checks exercise signup → verify → login → logout → forgot/reset → login → change password → login → logout-all on isolated ports with a Buyer fixture and captured Redis links, including anonymous-route redirects and mobile/desktop layout checks.

Deployment rate limiting is process-local, and frontend refresh-request deduplication is process-local. Distributed deployment requires shared limiting and a tested multi-instance refresh strategy. Proxy trust must be configured for the actual hosting topology; this code does not blindly trust forwarded client addresses. Supplier contact/ownership/subscription checks must be added with their respective resource milestones; M1 does not create those resources. The prior Prisma configuration dependency advisories remain documented in M0.

## Current validation results

- Backend: schema validation, migration generation/application, repeatable migration deploy, lint, type checking and production build passed.
- Nine backend tests passed, including policy-disabled registration, token expiry/resend/reuse, user/admin authorization and role/status changes, and mocked Resend adapter success/failure.
- Frontend lint, production build and TypeScript checks passed with NextAuth 4.24.15.
- Chromium full auth flow passed on mobile (390px) and desktop (1440px); administrator UI role assignment passed. These checks used an explicit Buyer test configuration on isolated ports and captured Redis email links. Fixtures were deleted afterwards.
- Actual email worker startup without credentials failed as expected with a missing-key/sender error; no external email was sent and live delivery is unverified.
- Frontend production dependency audit reports zero vulnerabilities. The three inherited high Prisma configuration findings remain.
- AloSkill is unchanged; main branches are unchanged.

## Files

New backend feature modules: `src/modules/auth/` and `src/modules/user/`; authentication middleware and hashing/token/JWT utilities; `src/emails/` queue/provider/templates/worker; Prisma migration; configuration/bootstrap helpers; authentication, email-adapter and signup-policy tests. Updated server config/routes/shutdown/error handling, manifests/lockfile, environment example and documentation.

New frontend files: `src/app/auth/` pages/layout; NextAuth API handler and session context; protected dashboard account and admin user pages/components; reusable auth/profile/verification forms; auth/user API services; NextAuth configuration; form schemas and authentication types. Updated root/header/configuration, manifests/lockfile, environment example and documentation.
