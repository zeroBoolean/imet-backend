# Milestone 0 — Product Foundation & Technical Setup

## Scope

The user approved the architecture review's proposed foundation scope. The supplied attachment is a development master prompt, not a detailed milestone acceptance document. This milestone establishes the two existing repositories without inventing business rules or implementing M1.

Adopted from AloSkill: separate Next.js/Express applications, App Router route groups, shared frontend components and API utilities, backend feature modules, strict TypeScript, Zod, Prisma 7 PostgreSQL adapter, mapped-model conventions for future models, and the planned queued Resend email abstraction.

Corrections in the foundation: server/public environment separation, matching Next.js ESLint version, real database readiness, consistent field-error contract, preserved parsed validation output, status-aware API failures, and safe error responses. Authentication-specific corrections will be handled in M1, including hashing reset/verification tokens and enforcing account status and revocation.

## Acceptance checks

- Both applications install reproducibly from repository lockfiles.
- Both pass lint, TypeScript, and production builds.
- The backend starts only after a successful database query.
- Readiness returns connected status with PostgreSQL available and 503 when it is unavailable.
- Frontend renders and can check API/database readiness, with loading, failure, and retry states.
- Tests exercise real database connectivity, safe JSON/404 errors, headers, and validation behavior.
- PostgreSQL and Redis startup/configuration are documented; business tables and email delivery are not implemented.
- No credentials are committed, and AloSkill remains unchanged.

## Deferred

M1 authentication/user management, transactional emails and worker implementation; later marketplace and domain models, role dashboards, subscription entitlements, RFQ, storage selection, translation provider, and advanced media.

## Validation results

- Frozen `npm ci` succeeded for both repositories through the tested cloud install script.
- Frontend and backend lint, TypeScript checks, and production builds passed.
- Prisma schema validation and client generation passed.
- Six backend tests passed with no failures or skips.
- Chromium checks passed at 1440px and 390px: connected API/database state, no horizontal overflow, actual PostgreSQL outage with HTTP 503 and frontend failure state, and recovery using retry after database restart.
- PostgreSQL `SELECT 1` and Redis `PING` succeeded; both Compose services are healthy.
- AloSkill reference checkouts remain clean.

## Dependency choices and remaining limitation

Development startup commands were also executed and the browser confirmed frontend/API/PostgreSQL connectivity. Next.js generated frontend `AGENTS.md` and `CLAUDE.md` documentation guidance during startup; these are retained as setup documentation.

The reference baseline was retained structurally, with Next.js/ESLint config updated to 16.3.8, Prisma packages to 7.10.0, and express-rate-limit to 8.7.0 after security auditing. A compatible mysql2 3.24.5 override addresses an advisory in Prisma's transitive tooling dependency; iMet uses PostgreSQL, not MySQL. Prisma 7.10 generation also resolved the earlier engine download blocker without disabling checksums or TLS.

Frontend production dependency auditing reports zero vulnerabilities. Backend auditing still reports three high findings originating from Prisma's deepmerge-ts 7.1.5 configuration dependency (including its parent packages). The advisory concerns merging recursive object graphs. Prisma configuration here is static, and the API does not accept user-provided Prisma configuration. No compatible 7.x fix was reported; the suggested automatic change would downgrade Prisma to 6, while deepmerge-ts 8 would require a major transitive override. Neither was silently applied. This is a known tooling limitation, not a passing security audit or a production readiness claim.

The cloud configuration draft saves the install script and startup instructions. Saving a draft does not publish an environment or verify a new task.

## Files created

Both repositories were empty before this milestone; all application/configuration files are new. No existing tracked iMet files were modified. Generated dependencies, Prisma output, Next.js output, and local environment files are ignored.

### imet-client

```text
AGENTS.md
CLAUDE.md
.env.example
.gitignore
.nvmrc
.prettierrc.json
README.md
eslint.config.mjs
next.config.ts
package-lock.json
package.json
postcss.config.mjs
src/app/(withoutSidebarLayout)/layout.tsx
src/app/(withoutSidebarLayout)/page.tsx
src/app/error.tsx
src/app/globals.css
src/app/layout.tsx
src/app/loading.tsx
src/components/buttons/Button.tsx
src/components/shared/Header.tsx
src/components/shared/SystemStatus.tsx
src/config/env.ts
src/lib/api/client.ts
src/lib/api/health.service.ts
src/lib/utils.ts
src/types/api.ts
tsconfig.json
```

### imet-server

```text
.env.example
.gitignore
.nvmrc
.prettierrc.json
README.md
compose.yaml
docs/milestone-0.md
eslint.config.js
package-lock.json
package.json
prisma.config.ts
prisma/schema.prisma
scripts/cloud-install.sh
src/app.ts
src/config/database.ts
src/config/env.ts
src/middleware/errorHandler.ts
src/middleware/security.ts
src/middleware/validation.ts
src/modules/health/health.controller.ts
src/modules/health/health.routes.ts
src/modules/health/health.service.ts
src/routes/index.ts
src/server.ts
src/types/shared.ts
src/utils/asyncHandler.ts
src/utils/logger.ts
src/utils/response.ts
tests/foundation.test.ts
tests/middleware.test.ts
tsconfig.json
```
