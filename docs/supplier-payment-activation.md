# Updated M4: supplier subscription activation

The supplied updated M4 PDF authorizes SSLCOMMERZ hosted checkout and a separate audited administrator activation route. It supersedes the original specification's manual-only payment boundary for supplier subscriptions. Buyers remain subscription-free. Machinery purchases, commissions, refunds, recurring billing and other payment gateways are outside this change.

## Reused architecture

Existing Express modules, controllers/async response handling, Zod validation, live database-backed auth/session middleware, Prisma/PostgreSQL transactions, supplier profiles, plan snapshots, partial unique current-term constraint, admin audit log and subscription entitlement helpers are retained. NextAuth, typed API services, React Hook Form forms, password inputs, dashboard shell and private Bunny supplier uploads are reused on the frontend. AloSkill is read-only; its URL-encoded hosted-checkout/init/validation pattern is reused with stricter validation, private projections and transactional idempotency. No new dependencies were installed.

## Registration and account access

`POST /auth/register-supplier` accepts the existing account fields, company profile and eligible active plan ID. The account, company, pending plan snapshot and durable email intent are created together. The account is `PENDING`, initially email-unverified. Email verification changes verification only; supplier accounts remain pending until activation. Buyer registration still follows the original `PENDING_VERIFICATION → ACTIVE` lifecycle.

Verified pending suppliers may sign in, refresh, recover/reset passwords, sign out and use narrowly scoped payment/onboarding endpoints. General authentication, dashboard access and business endpoints still require `ACTIVE`. Generic user administration cannot directly turn a pending supplier into active without the activation route. Existing approval, verification badges, role checks and private contact rules remain separate; activation approves marketplace operation but never grants an information-verification badge or clears contact restrictions.

Pending supplier onboarding reuses existing company/file validation and asset binding. The new pending-account upload permission is restricted to its own pending profile; the older buyer-account pending-application upload restriction remains unchanged. After approval, existing permitted owner/admin fields apply.

## Schema and migration

- `UserStatus.PENDING` is additive; existing account defaults/statuses and records are preserved.
- Existing `SupplierSubscription` gains `planVersion`, activation method/time/actor/reason and payment relations. Existing plan price, currency, duration and entitlement snapshots remain the subscription source of truth.
- New `PaymentTransaction` records user/subscription, SSLCOMMERZ provider, unique merchant transaction ID and validation ID, per-user idempotency key, amount/currency snapshots, pending/paid/failed/cancelled/expired/review status, checkout/session details, minimal validated provider metadata, risk/review reason and timestamps.
- Uniqueness and foreign keys prevent identity reuse and orphaned financial history. Database checks reject nonpositive amounts, malformed currencies, unvalidated paid/review states and manual activation metadata without a reason.
- Legacy activation metadata remains null rather than inventing payment or actor history.

Deploy migrations `20261007120000_m4_subscription_payments` and `20261007123000_payment_guards` through the existing migration workflow. No database reset, seed price or data rewrite is required. The upgrade test applies migrations in an isolated rolled-back schema and verifies preservation and financial constraints.

## API

All paths below are under `/api/v1`.

| Access | Method and path | Behavior |
| --- | --- | --- |
| Public, rate-limited | `POST /auth/register-supplier` | Account/company/pending term and verification email |
| Verified owner; pending allowed | `GET /payments/onboarding` | Own company, eligible plans, safe payment history and gateway availability |
| Verified owner; pending company only | `PATCH /payments/onboarding` | Optimistic company edit, existing asset binding; blocked during pending/review payment |
| Verified owner; pending allowed | `POST /payments/checkout` | Strict `{planId,idempotencyKey}`; database pricing and server checkout initialization |
| Verified owner; pending allowed | `GET /payments/:id` | Own safe payment/subscription state; foreign payment returns 404 |
| Verified owner; pending allowed | `POST /payments/:id/reconcile` | Bounded server-side merchant transaction lookup and validation |
| Public provider callback | `POST /payments/ipn` | JSON or bounded URL-encoded payload; authoritative validation required |
| Public informational redirect | `GET/POST /payments/callback/:result` | 303 to owner-protected payment screen; never changes financial/account state |
| Active admin | `GET /admin/suppliers/:id/payments` | Read-only transaction/validation/risk/payment details |
| Active admin | `POST /admin/suppliers/:id/activate` | Confirmed, reason-required, optimistic manual account/subscription activation |

There are no payment update/delete endpoints and no endpoint accepting a browser-provided price, paid status or activation flag.

## Hosted checkout and verification

The backend POSTs merchant credentials, its generated transaction ID, snapshotted amount/currency and customer/company information to `/gwprocess/v4/api.php`. URLs are derived from configured API/frontend origins. Gateway checkout URLs must be HTTPS on the selected provider's approved host, without embedded credentials. Network calls use bounded timeouts and reject redirects; credentials and raw payloads are never included in public responses or application logs.

For `val_id`, the backend calls `/validator/api/validationserverAPI.php` using its credentials. It requires `VALID` or `VALIDATED`, matching transaction and validation IDs, exact Decimal amount and original currency, and a risk indicator. Original `currency_amount/currency_type` are used when returned for currency conversion. Without a validation ID, merchant transaction lookup uses `/validator/api/merchantTransIDvalidationAPI.php`; a valid lookup must still pass Order Validation. Browser/IPN amount/status/cancellation claims alone cannot change state.

Risk level other than `0`, suspended/ineligible accounts, or a replaced/nonpending subscription place a genuinely validated payment into `REVIEW`, with no automatic activation. Review is deliberately held rather than cleared by repeated notifications. Administrators can separately grant an audited manual term without rewriting payment facts. Refund/review disposition must be handled operationally with the merchant; no financial override UI is provided.

Under supplier, account and payment row locks, valid eligible payment commits PAID payment, ACTIVE subscription, ACTIVE account and the matching supplier/manufacturer role together. Term dates begin at verified activation and use snapshotted admin-defined duration. Repeated/concurrent notifications return idempotently without extending dates or creating another subscription. Competing/late payments for a term already activated or replaced are held for review rather than extending it.

Checkout initialization reserves a durable pending attempt before calling the provider. Same idempotency key reuses it; another pending/review attempt blocks a new checkout. Explicit initialization rejection is failed; ambiguous network errors remain pending for authoritative reconciliation. Failed/cancelled/expired attempts can be retried with a new key. Successful lookup with no transaction after the local 30-minute checkout window expires an unconfirmed attempt; ongoing/unknown provider records stay pending. An existing active term prevents early duplicate purchase; renewal after expiry is supported. Suspended/cancelled subscriptions require admin intervention.

## Manual activation and audit

The administrator selects an existing active eligible plan, sets valid start/end dates, enters a reason of 10–2000 characters and explicitly confirms. API validation rejects missing confirmation, reasons, stale supplier/term versions or ineligible/unverified/suspended accounts. Transactional checks revalidate current admin access and existing listing limits.

The transaction replaces the current term, records `ADMIN_MANUAL`, actor/time/reason, activates the account and approved company/appropriate role, and writes one `SUPPLIER_MANUAL_ACTIVATION` audit event with reason/target user. It creates no gateway payment or fake paid record. Future-dated terms remain effectively pending until their start. Existing audited term administration remains available for previously active approved accounts.

## Homepage and M5–M6 compatibility

The homepage continues using `GET /subscriptions/plans` with live database-defined active plans, prices, currencies, durations and existing limits; no hard-coded subscription prices. Updated CTA/copy explains secure checkout and manual activation. Supplier activation is linked from its dashboard.

Existing catalogue publication, RFQ routing, lead caps, quotes, accepted-sale lifecycle and private contact gating consume the same approved supplier + active verified account + correct role + applicable current active term snapshots. Payment/manual activation produces those existing records; no RFQ, sale, buyer subscription or contact-permission architecture was replaced. Subscription expiry still disables supplier changes/public eligibility while preserving permitted history. Buyer RFQs and private competing quote visibility remain governed by existing rules.

## Environment and merchant configuration

Set only on **imet-server**:

```dotenv
SSLCOMMERZ_STORE_ID=<sandbox merchant store ID>
SSLCOMMERZ_STORE_PASSWORD=<sandbox merchant store password>
SSLCOMMERZ_IS_LIVE=false
SSLCOMMERZ_CURRENCIES=BDT
PAYMENT_CALLBACK_ORIGIN=https://api.your-domain.example
FRONTEND_URL=https://your-frontend.example
```

Obtain merchant credentials from SSLCOMMERZ; enter them securely in environment settings or backend `.env`, never chat/source/frontend variables. `PAYMENT_CALLBACK_ORIGIN` is the publicly reachable HTTPS API origin, without `/api/v1`. Existing frontend API origin, NextAuth signing secrets/URL, database, Redis, Resend worker and Bunny upload settings still apply. `SSLCOMMERZ_CURRENCIES` must match currencies your merchant is authorized to collect; unsupported/zero-price plans use manual activation. Prices and duration come from database plans, not environment values.

Sandbox provider origin is `https://sandbox.sslcommerz.com`; live is `https://securepay.sslcommerz.com`. Mode-restricted override configuration cannot direct secrets elsewhere. Allow gateway network domains `sandbox.sslcommerz.com`, `sandbox-gw.sslcommerz.com` and `securepay.sslcommerz.com`. The cloud environment draft adds these destinations and secret requirements; saving the draft does not enable or publish live credentials/network configuration.

Configure/allow these merchant callbacks and ensure the gateway can reach them without login, bot challenges or browser cookies:

- Success: `https://api.your-domain.example/api/v1/payments/callback/success`
- Failure: `https://api.your-domain.example/api/v1/payments/callback/fail`
- Cancellation: `https://api.your-domain.example/api/v1/payments/callback/cancel`
- IPN: `https://api.your-domain.example/api/v1/payments/ipn`

SSLCOMMERZ cannot notify localhost. Use a deployed HTTPS API or an approved public HTTPS tunnel for merchant sandbox testing. The frontend must be accessible at `FRONTEND_URL`. Callback/IPN routes sit under the existing API rate limiter; configure any production proxy/IP allowlists to permit legitimate gateway retries while retaining abuse protection.

## Deployment and validation

With the intended database and Redis available:

```sh
# imet-server
npm ci
npm run db:generate
npm run db:deploy
npm run typecheck
npm run lint
npm test
npm run build
npm run start
# Run existing transactional email worker separately: npm run worker:prod
```

```sh
# imet-client, with existing .env.local configured before build
npm ci
npm run type-check
npm run lint
npm run build
npm run start
```

No credentials, mock gateways or QA storage adapters are installed by this setup.

Validation completed: all 110 server tests pass, including the complete existing M1–M12 suite plus payment integration/provider/migration tests. Both repositories pass TypeScript, ESLint and production builds; all 21 migrations are deployed locally and Prisma reports no schema drift. Scenarios include verification, pending-account recovery and restriction, owner/admin access, forged amount/currency/status/identity, invalid validation, risk hold, concurrent duplicate notifications, failed/cancelled/expired retries, suspended accounts, late payment after manual activation, snapshot preservation during repricing, manual reason/confirmation/concurrency/audit/no fake payment, dynamic public plans, safe provider hosts/errors and migration preservation. Existing upload, auth, RFQ, sales and contact gates remain covered.

Chromium covers connected supplier signup, visibility controls, verification, restricted login, company logo/PDF uploads, checkout navigation, form-encoded IPN through validation, processing/verified state, dashboard access, manual admin dialog/audit, and dynamic homepage create/update/deactivate. Responsive checks use 1440/820/390 pixels. A second Chromium run against the normal API also verifies failed/cancelled/expired/pending/review screens at 390 pixels, hides checkout under a review hold, and preserves stored pending status with an actionable error when gateway configuration is unavailable. Provider and storage transports are emulated for these tests; real application UI/API/database logic is exercised.

Before production, execute a real merchant sandbox checkout for success, failure and cancellation with the public HTTPS API, confirm received IPN and provider validation, repeat the same IPN and verify unchanged term dates, and verify owner/admin status screens. Then obtain production merchant approval/credentials and switch to live mode only after those checks. No sandbox or production merchant credentials were available in this workspace, so external provider delivery, actual charging and merchant-specific currency support are not claimed as verified. Official documentation requests returned HTTP 403 here; endpoint transport follows the existing AloSkill integration and the published SSLCOMMERZ SDK, and requires the documented real sandbox acceptance check.
