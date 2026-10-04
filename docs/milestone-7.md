# Milestone 7 — Reviews & Ratings and Dynamic Homepage

Use matching `milestone-7` branches in both repositories. M7 builds on M0–M6 and retains the existing AloSkill/iMet route/controller/service, Prisma, NextAuth, Tailwind, form and shared-component architecture. No dependency or provider was added. AloSkill reference repositories remain unchanged.

## Confirmed rules

The supplied files state that reviews are required but do not define eligibility, target ownership or publication controls. The user confirmed all three proposed decisions:

- Only the buyer on a **COMPLETED** M6 sale can review the winning supplier profile and RFQ-linked machinery, when those targets exist. Reviews use integer 1–5 stars and non-empty text, once per sale and target. Buyers require no subscription. Sellers do not review buyers or internal salespeople.
- New and edited reviews require admin approval. Buyers can edit/resubmit or withdraw. Administrators can publish, reject or hide. Only published reviews appear publicly or contribute to ratings.
- All active admin-defined supplier/manufacturer plans are public on the homepage, including current prices, duration and existing feature limits. Deactivated plans disappear. Subscription activation/renewal remains manual and buyers remain subscription-free.

The backend derives author and target IDs from the authenticated buyer and completed sale; request bodies cannot set arbitrary authors, machinery, suppliers or publication state. A sale with no linked machinery supports no machinery review, and an internal salesperson with no supplier profile is not a supplier review target. Separate completed purchases may have separate feedback; each sale/target has one record. A withdrawn review can be edited and resubmitted using that same record. Withdrawal is not hard deletion. Administrators cannot override withdrawal without buyer resubmission.

Supplier expiry does not revoke a buyer's historical review eligibility. Public reviews follow the existing target visibility rules: unpublished machinery and suppliers without applicable approved/active marketplace visibility are excluded, including homepage highlights. Private buyer history remains available. Public identity is display name only; responses exclude email, contacts, RFQ budgets, sale IDs, quote amounts and private moderation metadata.

## Database

The additive migration `20261004133000_reviews` adds `Review`, `ReviewTarget` and `ReviewStatus`. A review relates to its existing sale, author and either machinery or supplier, with optional last moderator/time/feedback, creation/update timestamps and status. It adds no duplicate purchase, supplier or rating model.

Unique `(saleId, target)` prevents duplicate reviews. Foreign keys restrict deletion of reviewed sales/targets, preserving feedback history. Indexes support author/status lists and target/status/public ordering. SQL checks enforce exactly one target, ratings from 1 to 5 and non-empty text. Existing sale, RFQ, subscription and catalogue data is preserved; no migration seeds reviews or commercial data.

Ratings are derived from database aggregates over published reviews: arithmetic average (null for zero reviews), count and 1–5 distribution. There are no stored duplicate averages or hardcoded percentages. Public summary/list queries use a repeatable-read transaction and stable pagination.

## APIs

All paths are below `/api/v1`.

| Method | Path                                                       | Access / purpose                                                                       |
| ------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| GET    | `/reviews/public?target=MACHINERY\|SUPPLIER&targetId=UUID` | Anonymous; visible-target published reviews, average/count/distribution and pagination |
| GET    | `/reviews/highlights?limit=3`                              | Anonymous; up to six current published reviews of public targets                       |
| GET    | `/reviews`                                                 | Active verified buyer; own records, status/target/search filters and pagination        |
| GET    | `/reviews/eligibility/:saleId`                             | Owning buyer; completed-sale eligibility, derived targets and own reviews              |
| POST   | `/reviews`                                                 | Owning buyer; `{saleId,target,rating,body}`, creates Pending                           |
| PATCH  | `/reviews/:id`                                             | Author; `{updatedAt,rating,body}`, resubmits as Pending                                |
| POST   | `/reviews/:id/withdraw`                                    | Author; `{updatedAt}`, removes public visibility                                       |
| GET    | `/admin/reviews`                                           | Admin; moderation list, filters and pagination                                         |
| PATCH  | `/admin/reviews/:id`                                       | Admin; `{updatedAt,status:PUBLISHED\|REJECTED\|HIDDEN,note}`                           |
| GET    | `/subscriptions/plans`                                     | Anonymous; explicit projection of active admin-defined supplier plans                  |

Existing authentication checks sessions, current roles, email verification and account status. Strict Zod schemas validate UUIDs, integer ratings, text up to 5,000 characters, moderation feedback up to 2,000 characters and pagination up to 50 records. Edits, withdrawals and moderation require an `updatedAt` version. Buyer changes serialize on the M5 RFQ lock and review row; moderation shares the review lock. Conflicting edits/publication/withdrawal return 409 rather than overwriting another decision. Unique constraints handle concurrent duplicate creation.

The public plan endpoint lives in the existing subscription module and reads `SubscriptionPlan`, with no new source of pricing truth. Editing a plan still affects future assignments while existing assigned subscription snapshots remain unchanged.

## Frontend

- Buyer completed purchase `/dashboard/purchases/[id]`: eligibility-based supplier/machinery review forms, accessible star radios, inline validation, pending/published/withdrawn status, moderation feedback and edit/withdraw actions.
- Buyer `/dashboard/reviews`: owned feedback list with search, target/status filters, pagination and links back to purchases.
- Admin `/dashboard/admin/reviews`: existing role-protected layout, compact moderation cards, publish/reject/hide controls, optional buyer feedback, version conflicts and retry.
- Machinery `/machinery/[slug]` and supplier `/suppliers/[id]`: public average/count, real distribution and review lists with loading/empty/error/retry and pagination.
- Dashboard navigation exposes the appropriate buyer/admin review pages. Seller sale/history pages retain their existing behavior.

`ReviewForm`, `PurchaseReviews`, `PublicReviews`, `ReviewWorkspace` and `RatingStars` reuse existing Button, Badge, PageHeader, LoadingState and EmptyState. Forms use React Hook Form/Zod. No heavy UI library was introduced.

## Homepage

The homepage is now a live marketplace entry point:

1. Current categories from `/catalogue/categories` (only categories with publicly visible machinery, preserving M2 rules).
2. A six-item published machinery selection from the existing catalogue list, reusing imagery-forward MachineCard. No nonexistent featured-machinery flag or artificial statistics were introduced.
3. Active supplier plans from `/subscriptions/plans`, displaying actual price/currency, duration, eligible supplier types, listing/media/specification limits, RFQ lead allowance, conditional contact-reveal permission and visibility level. There is no online payment CTA.
4. Active approved suppliers/manufacturers from the existing public supplier list, with verification/location and no private contacts.
5. Recent published completed-purchase feedback from `/reviews/highlights`, with actual ratings and reviewer display names.

Five independent API-backed server components stream in parallel under Suspense. Each has loading/empty/error/retry behavior; one failed section does not prevent the rest of the homepage rendering. Existing API services use `cache: 'no-store'`, so the next request/refresh reflects current admin data. No homepage database access, duplicate aggregation endpoint, CMS, hardcoded plan list, fake counts or testimonials were added. Design labels, icons and explanatory copy remain frontend presentation.

## Setup and validation

Apply the reviewed additive migration to the intended database:

```bash
# imet-server
npm ci
npm run db:generate
npm run db:validate
npm run db:deploy
npm run typecheck
npm run lint
npm run build
npm test
npm start

# imet-client
npm ci
npm run type-check
npm run lint
npm run build
npm start
```

Keep existing PostgreSQL/Redis, signing/session configuration and M5 RFQ worker. No new worker or environment binding is required. Existing Resend/Bunny credentials remain necessary only for their existing email/upload integrations; review submission/publication sends no new notification.

Database integration suites share a real development database and global salesperson routing. `npm test` now runs test files with concurrency 1 to prevent one suite's temporary salesperson becoming another suite's assigned recipient during cleanup. Concurrent request/race tests still execute `Promise.all` within each suite. No assertion or suite is disabled.

Tests cover completed-sale ownership/eligibility, invalid/forged input, inactive/unauthorized roles, duplicate races, moderation/edit/withdrawal races, private/public projections, actual multi-review averages/distribution/pagination, supplier expiry and public visibility, and admin plan create/update/deactivate synchronization. A rolled-back private-schema migration test verifies unchanged existing sales and review target/rating/text/duplicate/FK guards. Existing M0–M6 regressions remain included.

Browser validation starts with real M5 RFQ creation/quotation and M6 completion, then verifies star selection/validation, submission, admin approval, public averages, buyer editing/withdrawal and admin dashboard plan creation/price update/deactivation reflected on the homepage. Responsive/public/privacy and loading/empty/error/retry checks cover mobile, tablet and desktop.

Only M7 and the requested dynamic homepage are implemented. No M8–M13 features, payment integration, unrelated notifications, analytics or new architecture were added. All blocking M7 product questions were answered by the user.

### Verified results

- Backend: 37 tests passed, zero failures/skips; focused M7 lifecycle and migration checks included.
- Both repositories: lint, type checks and production builds passed.
- Prisma: schema valid, seven migrations applied, no schema drift.
- Chromium: real RFQ/quote/completed-sale review lifecycle and admin plan create/update/deactivate synchronization passed.
- Responsive pages: 390px mobile, 820px tablet and 1440px desktop passed, including buyer forms, moderation, public details and seller sale-history regression. Long category/review text was checked.
- Public reviews: failure/retry remains local to the review section. Homepage: independent plans failure/retry, streamed loading and clean-database empty feedback passed.
- Mobile public-review pagination passed using eleven real temporary completed-purchase reviews across three pages.
- PostgreSQL/API readiness and a Redis RFQ-maintenance worker job passed after fixture cleanup.
- Fixtures are temporary; no review/commercial data is seeded and no live provider delivery is claimed.
