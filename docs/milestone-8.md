# Milestone 8 — AI Translation

Use matching `milestone-8` branches of imet-server and imet-client. M8 extends M0–M7 without replacing routes, original fields, authentication or the AloSkill/iMet module architecture. AloSkill references are unchanged. No dependency, microservice or worker is added.

## Confirmed scope

The user selected **OpenAI**, public content only and admin-controlled generation:

- Machinery name and description.
- Machinery specification **labels**, never their values.
- Public supplier/manufacturer description, never company identity or contact fields.
- Published public buyer review body, never private moderation feedback or sale details.

Languages are exactly `en` (English), `bn` (Bangla), `zh` (Chinese), including all six cross-language directions. Administrators explicitly choose the actual original language per field; existing content is not assumed to be English. Chinese is presented as 中文 under `zh`; there is no region-specific language architecture.

Private RFQs, quotation notes, conversations, internal sales notes, attachments, prices/currencies, company names, category/plan names, manufacturer/model columns, URLs and system identifiers are outside translation scope. Existing search, sorting, routes, metadata and editing forms continue to use originals. Interface labels remain English; M8 translates the approved marketplace content, not the entire application UI.

## Original preservation and cache

Originals stay in their existing Machine, MachineSpecification, Supplier and Review columns. Generation derives text from the referenced database resource, never arbitrary client-provided text or author IDs. A SHA-256 hash identifies the exact source, including whitespace. An admin submits that hash from the management screen, so an edit between loading and submission returns 409. The service checks the source again after the provider call. A changed or hidden resource cannot publish a stale result.

`ContentTranslation` is a normalized field-level cache with four optional real resource foreign keys (exactly one required), allowed field, source/target language, source hash, translated text, status, claim ID/lease and timestamps. A unique backend-derived resource/field/target key permits one current row; regeneration replaces only this cache row. Source-language changes are part of cache validity. Foreign-key cascades remove obsolete caches when reviewed resources or rebuilt specification rows are deleted. Originals and existing review/sale deletion rules remain unchanged.

Statuses are PROCESSING, COMPLETED and FAILED; read projections additionally report MISSING or STALE without returning stale text. Same-language generation stores the unchanged original as an identity result and does not invoke OpenAI. Completed unchanged results are reused. Failed results can be retried. A processing lease prevents concurrent duplicate calls and permits retry after abandonment/expiry; a newer claim cannot be overwritten by an old response. A request with a different source while a previous lease is active returns 409.

A short PostgreSQL advisory-lock transaction claims work and reserves usage. No DB lock/transaction is held across the external HTTP request. `TranslationUsage` stores durable global provider-attempt counts per UTC day, so API restarts do not reset allowance. Failed external attempts consume allowance; cache reads, cache hits and same-language operations do not. This bounds requests, not a currency-denominated invoice; provider billing remains managed in the OpenAI account.

The additive migration `20261004151000_translations` creates only these enums/tables/indexes/constraints. `20261004154000_translation_cache_keys` additionally checks that each unique cache key matches its real resource, field and target language, preventing duplicate logical entries or mismatched keys. It leaves the already-applied initial migration unchanged. Existing M0–M7 data is preserved and no commercial/translation data is seeded. The public machinery-detail projection adds a specification `id` alongside existing `label` and `value` so labels have stable cache references. Existing consumers of label/value remain compatible; regression tests check that these originals and their ordering are unchanged.

## API

All paths are below `/api/v1`, with the existing response envelope, error handling and strict Zod validation.

| Method | Path | Access and behavior |
| --- | --- | --- |
| POST | `/translations/read` | Anonymous, read-only batches of 1–40 public field references and `targetLanguage`; never generates or spends quota |
| GET | `/admin/translations/resources?type=MACHINERY\|SUPPLIER\|REVIEW&q=&page=1&limit=10` | Active verified admin; eligible public resources, bounded search/pagination, provider availability and input limit |
| GET | `/admin/translations/resources/:type/:id` | Admin; original fields, source hashes and current en/bn/zh cache statuses/results; machinery includes specification labels |
| POST | `/admin/translations/generate` | Admin; `{resource:{type,id,field},sourceLanguage,targetLanguage,sourceHash,regenerate}`; 200 completed/cache/identity, 202 existing processing |

Allowed resource/field combinations are MACHINERY/NAME or DESCRIPTION, SPECIFICATION/LABEL, SUPPLIER/DESCRIPTION and REVIEW/BODY. Unsupported languages, forged field combinations, extra raw text, bad UUIDs and oversized batches are rejected. Read projections contain only resource reference, original source text, declared source language when current, requested target, safe status and current translated text. They contain no keys, claims, provider model/configuration, reviewer email, sale IDs, prices or contacts.

Visibility is checked on every read and before/after generation using existing `publicMachineWhere`/`publicSupplierWhere`. Supplier approval, applicable active subscription and marketplace visibility still gate public supplier/machinery content. Reviews must be PUBLISHED and their target publicly visible. Hidden/pending/withdrawn reviews, draft machinery and inactive supplier content cannot be translated or exposed through a cache lookup. A stale/failed result falls back to the original; an invisible resource returns 404.

The existing general API limiter remains. Generation additionally permits 10 requests per authenticated admin per minute, with the daily global attempt ceiling. Regular buyers/sellers and anonymous users cannot generate or access management endpoints. Missing key, rate limits, invalid output, timeouts and unexpected provider failures return safe errors without raw upstream payloads.

## OpenAI adapter

`translation.controller` delegates to `translation.service`; only `translation.provider.ts` knows the fixed `https://api.openai.com/v1/responses` endpoint. Native fetch avoids an unnecessary SDK dependency. Redirects are rejected, requests time out, output tokens and response bytes are bounded, and `store:false` avoids requesting Responses API storage. This does not make claims about OpenAI's separate account/data-retention policies.

Plain-text content is split into ordered lines. Indentation, leading bullets/numbering/headings, trailing whitespace and blank lines remain separate from translatable words. Protected placeholders preserve recognized technical numbers, units, signed/fraction/scientific values, tolerance operators, uppercase identifiers, model codes, table separators, embedded URLs/emails/phones/filenames and literal markup. Contact/link/file strings are masked from the provider payload and restored unchanged. No HTML is rendered as trusted markup; React escapes returned strings.

The reusable industrial prompt requests faithful meaning/terminology, no invention, summary, commentary or embedded-instruction execution, and exact placeholders/order/line count. OpenAI returns a strict JSON schema with translated lines. The adapter rejects incomplete/refused/malformed/empty/oversized outputs, changed/missing/duplicate protected tokens, new technical values, changed structure and responses lacking the requested script for human-readable content. Recognized protected tokens are conservative: unusual codes or units may require original-view inspection; AI quality still needs live review. Failures never change source columns.

## Frontend

`LanguageContext` follows the existing `src/app/contexts` convention. Native labelled controls in Header/DashboardShell select English/বাংলা/中文 and a global Show originals/Show translations toggle. Language preference persists locally, with memory fallback if browser storage is unavailable. Original-language metadata is never inferred from the browser's locale.

`TranslatedText` reads safe caches in batched requests, deduplicates within a bounded 30-second browser read cache and never calls a provider or generates in render/effects. It keeps originals visible during loading, missing/stale/processing/failed caches, blocked storage or API errors. Available translations have correct `lang` tags; unknown original language uses an empty language tag rather than declaring English. Bengali/CJK text uses natural character spacing. Server-rendered pages preserve their existing data fetching and UI while translated text hydrates progressively. A browser refresh reads the latest cache; source edits invalidate by hash and changed original props.

Public integrations include machinery cards/detail (name/description/specification labels), homepage machinery/review target names, supplier descriptions and public/homepage review bodies. Values, editing forms, routes and protected M0–M7 workflows remain original. The admin `/dashboard/admin/translations` page reuses the existing role-protected layout, API client, Button/Badge/LoadingState/EmptyState and React Hook Form. It supports public-resource search/paging, original/status/result inspection, explicit source/target selection, generate/use-cache, regenerate/retry, loading/errors and missing-key/size guidance. It adds no bulk background generation or unrelated admin functionality.

## Configuration and deployment

Backend only; never put the key in `NEXT_PUBLIC_*` or send it in chat:

| Variable | Default / purpose |
| --- | --- |
| `AI_TRANSLATION_API_KEY` | Required for cross-language generation; enter securely in backend/environment settings |
| `AI_TRANSLATION_MODEL` | `gpt-4.1-mini`; use a model supporting Responses structured outputs |
| `AI_TRANSLATION_TIMEOUT_MS` | `20000` (1,000–60,000) |
| `AI_TRANSLATION_MAX_CHARACTERS` | `6000` per field (100–12,000); oversized fields retain originals and show a clear limit |
| `AI_TRANSLATION_DAILY_LIMIT` | `50` provider attempts per UTC day (1–1,000) |

No frontend credential, new Redis worker or payment integration is needed. Keep PostgreSQL/Redis, current JWT/NextAuth and previous Resend/Bunny/M5 worker configuration. Missing AI credentials disable cross-language generation while original browsing, cached reads and same-language generation remain functional. The environment draft adds the secure key requirement for `api.openai.com` and suggested model; entering a key and publishing/saving settings is separate from code deployment.

```bash
# imet-server, intended development/deployment database
npm ci
npm run db:generate
npm run db:validate
npm run db:deploy
npm run typecheck
npm run lint
npm run build
npm test
npm start
npm run worker:rfq:prod # separate session, existing M5 maintenance

# imet-client, separate checkout/session
npm ci
npm run type-check
npm run lint
npm run build
npm start
```

Never reset existing databases/delete volumes. Repeat deploy/status to confirm no pending migrations. Read both READMEs and retain previous milestone setup instructions. An unauthenticated OpenAI models request returned 401, establishing API reachability, not credential usability or live translation quality.

## Validation status

Tests exercise all six directions and same-language no-call behavior, original invariance, role/account/visibility controls, strict input and size validation, safe public projections, real cache hits, stale source/edits during calls, duplicate claims, abandoned processing, daily/per-admin limits, source-language metadata, provider transport failures/timeouts/invalid outputs, protected technical values and an additive rolled-back migration preserving M0–M7 data. Existing catalogue tests additionally verify new specification IDs with unchanged labels/values/order. Provider responses are mocked; no live OpenAI result or translation quality is claimed without a usable key.

Final verification: all 54 backend tests passed, with zero failures or skips; backend lint, typecheck and build passed. Prisma validation and repeat migration deployment/status passed (nine migrations, none pending). Frontend lint, typecheck and production build passed. Browser checks passed at 390, 820 and 1440 pixels for cached translations, original toggle, language persistence, stale/unavailable fallback, protected values, admin controls and buyer/supplier access. Admin generation/retry used mocked OpenAI transport; normal-server tablet/desktop checks verified missing-key guidance and same-language no-call generation. Live provider translation remains unverified until a usable backend key is configured. M9–M13 are not implemented; next milestone is M9 only after the user requests it.
