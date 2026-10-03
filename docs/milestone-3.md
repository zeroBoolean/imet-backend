# Milestone 3 — Admin Catalogue Management

Milestone 3 adds authenticated administrator management of the catalogue created in M2. Both milestone-3 branches include M1/M2. It reuses AloSkill feature modules, centralized validation/response handling, Prisma transactions, protected Next.js dashboard pages, typed API services and React Hook Form/Zod forms. AloSkill and the main/milestone-1/milestone-2 branches are unchanged.

## Scope

- Create, rename, change slugs and delete one-level categories. Database foreign keys prevent deleting categories containing any draft or published machines.
- Search, filter by category/status, and paginate the admin machine list, including drafts.
- Create/edit machinery with name, slug, description, manufacturer, model, category, publication status, ordered images and technical specifications.
- New records default to DRAFT. Explicit PUBLISHED status makes a machine available through M2's public API. Returning it to DRAFT hides it immediately from uncached public queries.
- Add/remove/reorder image URLs and specification rows. Images require HTTPS URLs without embedded credentials and nonempty descriptions. Images are referenced by URL, not uploaded or fetched by the backend.
- Delete machinery and its images/specifications after UI confirmation. Draft is the reversible alternative when a machine only needs to be hidden.

No supplier approval/ownership, subscriptions, RFQ handling, translation, uploads/storage integration, payment processing or audit-log system is added. Those need their assigned milestones or the final storage infrastructure decision. Public catalogue responses continue to have no prices or supplier contacts.

## API and authorization

All routes below are under /api/v1/admin/catalogue and require a valid session for an active, verified user with a current ADMIN role. Authorization is enforced at the backend for every route, including reads; hiding the dashboard alone does not grant protection. Middleware reads current database roles/session state, so revoked sessions and removed roles stop working.

Categories:

- GET /categories — all categories, including unused ones, with machine counts.
- POST /categories — name and unique lowercase hyphen-separated slug; 201 on creation.
- PUT /categories/:id — complete name/slug payload.
- DELETE /categories/:id — 409 if category contains machines, 404 if missing.

Machines:

- GET /machines — q up to 100 characters (matches name/manufacturer/model/slug), categoryId UUID, status DRAFT/PUBLISHED, page 1–10000, limit 1–100 (default 20). Stable name/ID sort; count/page use a repeatable-read snapshot. Response data is { machines, pagination }.
- GET /machines/:id — the complete editable record, including updatedAt.
- POST /machines — full catalogue fields with optional status default DRAFT and image/specification arrays default empty; 201 on creation.
- PUT /machines/:id — full replacement payload plus the updatedAt value returned when opening the record. Child arrays are replaced, not appended. Array order determines positions.
- DELETE /machines/:id — JSON body { updatedAt } from the loaded record.

Mutations reject unknown fields, including prices, contact details, child IDs and client-supplied positions. Names/manufacturer/model are bounded at 200 characters, description 20000, category name 100, category slug 120, machine slug 220, image URL 2000/description 250, specification label 100/value 500, up to 20 images and 100 specifications. UUID route params, timestamps and enums are validated. Duplicate slugs and missing/in-use categories return safe 409 errors; missing records return 404.

Machine saves/deletes compare the supplied version atomically. A stale version returns 409; the administrator must cancel/reopen to load the current record. Accepted changes advance updatedAt monotonically. The version check, scalar update and child replacement occur in one transaction; invalid categories and failed operations leave the original record/children intact. Concurrent machine saves produce one success and one conflict. Category edits currently use normal last-writer-wins semantics; machine conflict protection does not apply to category names/slugs.

Slug changes intentionally change the public URL; the previous URL becomes unavailable. No redirect/history system is inferred. Review slugs before publishing. There is no automatic publication, demo seed or privileged account creation.

## Frontend and setup

Administrators open /dashboard/admin/catalogue through the Manage catalogue link on their account page. The server-rendered page checks current backend roles; anonymous visitors redirect to sign-in and non-admins see an access restriction. Client forms include field validation, submission disabling, mutation errors, reload controls, empty/loading states, publication explanations and explicit deletion confirmations. Category deletion is disabled while machine counts are nonzero, with a backend constraint for race safety. Machine editor row controls preserve/reorder display order.

Select milestone-3 in both existing checkouts. Use the existing M0/M1 environment setup and apply the M1/M2 migrations against the intended development database with npm run db:deploy; M3 introduces no new schema migration, dependency or environment variable. Use the existing secure admin:create provisioning command if an administrator is needed; credentials must be supplied securely as described in M1, and no real privileged account was provisioned by this implementation.

M1 signup-policy/live Resend delivery prerequisites and the previously documented dependency/distributed-deployment limitations remain. Category dropdowns retrieve all current categories; assess dataset size before adding category pagination. External image availability is not guaranteed; M2 image fallback applies. Supplier gating for future private resources must be implemented with those resources rather than exposing contacts through catalogue APIs.

## Validation

Backend schema validation, repeatable migration deployment, lint, TypeScript and production build pass. All 14 backend tests pass. The new database-backed admin test covers every protected endpoint with anonymous and all five non-admin roles; category create/update/delete, unique slugs and foreign-key restrictions; machine draft/public visibility, complete edits, ordered children, validation, rollback, stale and concurrent edits/deletes, cascades and current-role enforcement. M1/M2 tests remain green.

Frontend lint, TypeScript and production build pass. Chromium smoke checks exercise anonymous/non-admin restrictions and the administrator category/machine workflow at 390px and 1440px, including validation, reordering, publication/unpublication, public API visibility, delete confirmation/cancellation and horizontal overflow. Tests use temporary records/accounts removed afterwards and do not send email or change signup policy.

Stop after M3. No M4 implementation is included.
