# M3 catalogue gap completion

This increment preserves existing catalogue CRUD, publication, supplier entitlement checks, strict payload validation, transaction/version checks, ordered specifications and legacy HTTPS image records. It completes ordinary machinery image uploads for the admin catalogue, category edit conflicts, useful validation feedback and reversible archive controls. It does not add supplier logo/document uploads, supplier-side upload authoring, videos, payments or a new publication status.

## Storage architecture

The implementation uses the existing `services/bunnyStorage.ts` transport, provider configuration, fixed-host/key validation, timeouts and idempotent deletion. It also reuses the existing image-byte/dimension validator and durable UPLOADING → ACTIVE → DELETING pattern from advanced machinery media. There is no new storage provider, SDK, queue or dependency.

`CatalogueImageAsset` is ordinary-image metadata, separate from RFQ attachments and advanced GLB/panorama assets. It supports upload before a machine exists. It records the uploader, server-generated storage key, byte type, size, sanitized filename and SHA-256. `MachineImage.assetId` is an optional unique relation. Existing URL rows remain unchanged; one managed asset can bind to one machinery image row.

### Lifecycle and authorization

1. A live active/verified ADMIN session is required before multipart parsing. Uploads are limited to one file/request, 10 requests/minute per admin, and 20 unbound uploads per uploader. Reservation quota checks are serialized in PostgreSQL.
2. Ordinary pictures accept JPEG/PNG up to 10 MB, 8192 pixels per dimension and 32 megapixels. The backend detects actual bytes and validates structure/dimensions independently of filenames and client MIME headers. SVG, animated PNG, PDF and unsupported formats are rejected.
3. A durable reservation precedes Bunny PUT. Upload activation rechecks live admin role/account and the requesting session after storage I/O. Failed uploads enter retryable deletion; non-active assets never become public.
4. Create/edit validates owned staged asset references, locks asset rows and atomically binds them with the machine and ordered image descriptions. An already-attached asset can be retained by admins editing that same machine. Another uploader's staged asset and cross-machine reuse are rejected. Database uniqueness protects concurrent attachment.
5. New API image URLs are relative to the API base, `/catalogue/images/<uuid>/content`; the existing public image component resolves this canonical managed path. Legacy HTTPS URLs retain their original behavior. Public catalogue projections still expose URL/alt only, not upload ownership, storage credentials, filenames or hashes.
6. Authenticated admin previews keep staged/draft bytes private. Public delivery requires ACTIVE storage metadata attached to a machine matching the existing public publication/supplier/subscription entitlement predicate. Byte size/hash and visibility are rechecked after storage retrieval. Responses are no-store and nosniff; storage keys/passwords are never delivered to clients.
7. Removing/replacing managed images or deleting machinery retires detached assets in the same catalogue transaction. Archiving retains images and specifications and immediately gates subsequent public image requests. Stale/failed saves neither detach rows nor retire files.
8. The catalogue cleanup worker retries DELETING records, retires abandoned ACTIVE unbound uploads after 24 hours, and removes interrupted UPLOADING reservations after one hour. Provider deletion failures retain durable metadata for retry. Linked assets are excluded and checked under a row lock before cleanup.

External URL images remain supported, so bytes hosted externally remain controlled by that external host. Existing advanced-media deletion/history restrictions remain in force.

## API additions and compatibility

- GET `/api/v1/admin/catalogue/image-uploads/status` — configuration readiness and maximum bytes.
- POST `/api/v1/admin/catalogue/image-uploads` — multipart `file`; returns owned asset reference and preview metadata.
- GET `/api/v1/admin/catalogue/image-uploads/:id/preview` — authorized admin preview.
- DELETE `/api/v1/admin/catalogue/image-uploads/:id` — remove an uploader's unbound file; attached files must first be removed through a versioned machinery save.
- GET `/api/v1/catalogue/images/:id/content` — gated public bytes.

Machine image payloads accept existing `{ url, alt }` rows or `{ assetId, alt }` managed references. An optional managed `url` must equal its canonical path. Returned admin machine images include nullable assetId so existing managed files survive edits, including existing supplier-owned record edits; supplier-side upload APIs are not introduced.

Category updates now require the `updatedAt` returned by category reads/create/update. HTTP PUT without a version is rejected. Stale/concurrent category edits return 409 and accepted updates advance their version monotonically. Deploy frontend and backend together for this required M3 contract correction. Category deletion's existing in-use protection remains.

Archive uses the existing versioned machinery update with DRAFT status. The list action asks for confirmation, refuses stale list versions and preserves all machinery fields/ownership. Published status alone is not described as proof of public supplier visibility.

## Deployment

Apply the two additive migrations before running the updated server:

```sh
npm ci
npm run db:deploy
npm run build
npm start
```

Configure the existing server-only variables in `imet-server/.env` locally, or the backend/worker deployment's environment settings:

```dotenv
BUNNY_STORAGE_ZONE=your-existing-storage-zone-name
BUNNY_STORAGE_ACCESS_KEY=your-zone-storage-password
BUNNY_STORAGE_HOST=storage.bunnycdn.com
```

Use the host matching your existing Bunny zone's region. Never add the password to frontend environment variables or chat. No public pull zone is required; catalogue delivery is backend-gated. Restart the server and worker after configuration changes. With credentials absent, uploads fail safely with 503 and the form explains storage readiness while preserving URL editing.

Run the cleanup worker as a managed process with the same database and Bunny settings:

```sh
npm run worker:catalogue:prod
```

For development use `npm run worker:catalogue`. It retries every minute and handles SIGTERM/SIGINT. Deploy it alongside existing workers; it does not replace RFQ/email workers.

## Validation

- Strict TypeScript, lint, builds, Prisma schema validation and zero-drift migration check passed. Full backend regression suite: 106 passed.
- New database/API coverage includes all non-admin roles and anonymous access, byte/size/dimension validation, JPEG and PNG, staging privacy, ownership, race-safe binding/quota, public/draft/archived delivery, integrity mismatch, visibility changes during retrieval, session revocation during PUT, version conflicts, retained assets on failed writes, provider failures and durable orphan/interrupted cleanup.
- Production-build Chromium uses the real API/PostgreSQL plus an isolated Bunny transport emulator. It covers actual authenticated admin create/edit/upload/preview/reorder/specification persistence, storage failure/retry, publication and browser-decoded image delivery, archive, image retirement, stale edit/delete recovery, category conflicts and field feedback. The editor was checked at 390/820/1440 pixels with no horizontal overflow.
- Test accounts, records and failure flags are cleaned up. Emulator credentials/hooks are confined to the QA process and removed from normal startup. Actual live Bunny delivery requires the user's real configured zone/password and was not claimed as verified without them.
