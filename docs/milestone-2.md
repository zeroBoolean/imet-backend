# Milestone 2 — Public Marketplace & Catalogue

Implements the scope confirmed in this conversation: public listings with search, one-level category filtering and pagination; machine details with name, slug, description, manufacturer, model, images and technical specifications; published-only visibility; RFQ-only pricing without public supplier phone/email. Both milestone-2 branches include the Milestone 1 authentication foundation. AloSkill remains unchanged.

## Architecture

Reuses AloSkill's route/controller/service/validation feature modules, Prisma/PostgreSQL conventions, API response envelope, frontend App Router public route group, typed API services and shared cards. No new framework or dependency is introduced.

The Prisma migration adds MachineCategory, Machine, MachineImage and MachineSpecification. Machines default to DRAFT. PUBLISHED is the only public status. Category deletion is restricted when machines exist; machine deletion cascades to images/specifications. Image/specification position defines presentation order, with an ID tie-breaker. Supplier resources, ownership and contact/subscription access belong to later milestones and are not represented by arbitrary user joins.

## Public API

- GET /api/v1/catalogue/categories — name/slug for categories containing published machines.
- GET /api/v1/catalogue/machines — q (up to 100 characters), category slug (up to 120), page (1–10000), limit (1–48, default 12). Search matches name, description, manufacturer and model case-insensitively. Results sort by name and ID. Filtered count and page are read in a repeatable-read transaction.
- GET /api/v1/catalogue/machines/:slug — published details with ordered images/specifications. Draft and missing slugs both return 404.

List response data is { machines, pagination: { page, limit, total, totalPages } }. Details return the machine. Explicit select allowlists exclude internal status, timestamps, relation IDs and any future private fields. The catalogue schema has no price or supplier contact fields. Invalid/unknown query parameters return 422. Existing API rate limiting and safe error handling apply. No catalogue write endpoints are added.

## Frontend

Home links to /machinery. Search/filter forms use URL parameters and reset pagination on submission; pagination retains filters. Public server-rendered details live at /machinery/[slug], with metadata, category links, plain-text description and specifications. Loading, API outage/retry (a full reload at the same URL preserves filters), invalid filters, empty results and unavailable machine states are provided. Broken, absent and non-HTTPS images fall back to a machinery icon; images are lazy-loaded directly in the browser without a server image proxy and with no-referrer policy. Image hosting/upload validation belongs to M3/infrastructure setup.

Price on request is displayed. The detail page explicitly explains online quote requests are not yet available; RFQ submission/routing is M5. Admin catalogue management is M3. No unsupported quote button or contact disclosure endpoint is included.

## Setup and catalogue content

Use the existing environment setup from M0/M1, select milestone-2 in both repositories, generate the Prisma client, and run npm run db:deploy against the intended development database. No new environment variables are required. This migration is additive and was applied to the local development database; it does not deploy production or modify remote databases.

There is no automatic sample seed, publication or catalogue admin UI. An empty database displays the empty state. Populate reviewed catalogue records through a controlled database import until M3 supplies admin editing. Use lowercase hyphen-separated unique slugs, HTTPS image URLs, plain text descriptions/specification values, and explicit PUBLISHED status for records intended to be public. Tests create and remove their own published/draft fixtures; fixture content is not real catalogue data.

M1 signup-policy and live Resend delivery prerequisites remain outstanding; public browsing does not depend on them. Previously documented Prisma dependency advisories and deployment rate-limiting limitations remain. Substring search and offset pagination are suitable for this initial catalogue; assess query plans and search indexing when the actual catalogue size warrants it.

## Validation

Backend lint, TypeScript, production build, schema validation and repeatable migration deploy are required. The full backend suite contains 13 passing tests, including four database-backed catalogue tests covering publication/privacy, filtered search, deterministic pagination, ordered detail data, missing/draft 404, invalid input and absence of write endpoints. Existing authentication tests remain green.

Frontend lint, TypeScript and production build pass. Chromium checks use temporary records at 390px and 1440px for listing, filter/search, pagination, detail/specifications, broken image fallback, draft 404, empty results, invalid filters and horizontal overflow. Fixtures are deleted afterwards. A production-build browser check also verified API outage handling and successful retry after an actual backend catalogue readiness response. These browser checks are an execution-time smoke check, not a newly committed browser-testing framework.

Stop after M2. No M3 functionality is implemented.
