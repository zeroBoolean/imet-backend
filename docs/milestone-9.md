# Milestone 9 — Machinery 3D / 360 / VR

## Scope and confirmed decisions

M9 extends the existing catalogue, supplier/admin management and machinery detail. M0–M8 remain in place; AloSkill references were not modified. The user confirmed a lazily loaded Three.js viewer, self-contained static GLB 2.0 models, 2:1 JPEG/PNG equirectangular panoramas, capability-gated immersive WebXR VR, Bunny Storage through backend uploads, five advanced assets per machine, 25 MB models and 10 MB panoramas. Video playback, CAD conversion, AR, automated media conversion and M10–M13 are outside this milestone.

Standard images remain in `MachineImage`, preserving all existing image URLs, ordering, forms and API fields. `MediaType` distinguishes IMAGE, VIDEO, MODEL_3D and VIEW_360; M9 upload/API/database checks enable only the two confirmed advanced types. Existing images are the image implementation; VIDEO is reserved for a future implementation, not advertised as playable.

## Persistence and file safety

`MachineMedia` extends `Machine` with type, title, storage key, filename/MIME/size, SHA256, order, creation time and recovery state. Public metadata excludes storage keys, original filenames and integrity hashes. Two additive migrations add the relation/checks/indexes and the upload reservation state; there are eleven migrations in total. Existing catalogue, RFQ, sales, review and translation data are not rewritten.

A database transaction checks ownership/entitlement, locks the machine and reserves an UPLOADING record before network storage. Concurrent uploads count reservations toward the five-asset cap. After storage succeeds, authorization is checked again and the record becomes ACTIVE. UPLOADING and DELETING records are never publicly projected or served. Failed cleanup retains a durable record for manual retry. An interrupted UPLOADING record can be removed after one minute; active uploads reject premature removal. Failed deletions stay DELETING and expose Retry removal in management. Storage DELETE 404 is safely idempotent.

Remove advanced media before deleting machinery. The catalogue API returns a clear conflict while media rows remain, and a restrictive foreign key prevents silently orphaning files. Existing machinery without advanced media retains its deletion behavior.

Uploads accept one multipart `file`, `type` and `title`, with bounded fields/body and 10 uploads per minute per authenticated account (in addition to the existing general limiter). Authorization is checked before parsing the upload, and inside the persistence transaction. Supplier changes require the owning, approved account and applicable active subscription, including publication permission for published machinery. Admins manage all machines. Buyers and other suppliers cannot manage or preview private machinery assets.

Validation checks actual bytes, not client MIME or file extension:

- GLB 2.0 header/length, bounded JSON and exactly one embedded binary chunk; buffer views/accessor bounds and model hierarchy; bounded geometry, traversal, textures and materials.
- No external/data URIs, compressed extensions, animation, skinning or morph targets. Models must be static and embed PNG/JPEG textures (each at most 4096 pixels per dimension, at most 16 images and 32 megapixels total).
- JPEG/PNG panorama detection and dimensions: exactly 2:1, 512×256 to 8192×4096; PNG chunk bounds/checksums/completeness and no animated PNG; JPEG header/dimensions/end checks. Browser decoding remains the final compatibility check and falls back safely on malformed or unsupported content.

## Shared Bunny Storage and access

`src/services/bunnyStorage.ts` shares fixed-host, credentialed, timeout-bounded transport with existing RFQ attachments. RFQ routes retain their RFQ-only namespace validation, authenticated access checks and private responses. They are never delivered through the public machinery route.

Machinery storage keys are backend-generated `machinery/<machine UUID>/<object UUID>.<glb|jpg|png>`. No credentials or arbitrary upstream URLs reach the frontend. Assets are delivered through the backend rather than a public pull-zone URL, allowing every request to enforce current machinery publication and supplier visibility/subscription rules. This avoids making the existing private RFQ storage zone publicly browsable; no CDN/pull-zone setup is required.

Delivery has a bounded storage timeout and byte count, verifies exact stored size and SHA256, and rechecks visibility/recovery state after download. Responses use the known MIME type, `nosniff` and `no-store`; subscription expiry/unpublication therefore applies to subsequent requests. Previously downloaded files cannot be revoked from a user's device. Backend delivery incurs application bandwidth and memory for one bounded file per request; a future authenticated CDN design can address larger traffic without making RFQ files public.

## API

All paths start at `/api/v1`.

| Method | Path | Access |
|---|---|---|
| GET | `/catalogue/machines/:id/media` | Admin or entitled owning supplier; metadata/configuration state |
| POST | `/catalogue/machines/:id/media` | Same access; multipart upload |
| DELETE | `/catalogue/media/:id` | Same access; retryable file removal |
| GET | `/catalogue/media/:id/preview` | Same access; private bytes |
| GET | `/catalogue/media/:id/content` | Public only while the parent is visible in the existing catalogue |

Existing `/catalogue/machines/:slug` detail adds safe ACTIVE `media` metadata. Existing images/specifications/translations and public listing contracts remain intact.

## Frontend

Use **Manage media** beside a machine in Admin catalogue or Your machinery. The reusable management component supports upload, private preview, removal, storage-not-configured guidance, pending recovery states, empty/error/loading states and retries. It does not move the existing machinery editor.

Machinery detail starts with standard images. Selecting a 3D/360 asset dynamically loads the viewer and requests the asset; page render does not download advanced files. Models support drag/touch rotation, pinch/scroll zoom, keyboard arrows and labelled zoom/reset buttons. Panoramas support mouse/touch look-around, keyboard arrows and button zoom/reset. The renderer is responsive, caps pixel ratio and disposes controls, GPU assets, bitmaps and WebGL contexts on switch/unmount.

VR appears only in a secure context with `navigator.xr.isSessionSupported('immersive-vr')`. Entry requires a user click; rejected entry retains the normal viewer with a safe message. Unsupported VR does not block normal 3D/360. Failed downloads, unsupported WebGL/texture limits, context loss or decoding errors restore the standard image/gallery (or existing image-unavailable placeholder) with retry. Native media buttons remain keyboard accessible; canvas imagery is labelled. No headset is required for browsing.

The existing malformed machinery metadata title from M8 was corrected to use its original machine name; browser checks verify the document title.

## Setup and deployment

Server environment variables (backend only, never `NEXT_PUBLIC_*`):

- `BUNNY_STORAGE_ZONE`: your existing Bunny storage zone name.
- `BUNNY_STORAGE_ACCESS_KEY`: the storage-zone access key, entered securely in deployment/environment settings, never chat or source control.
- `BUNNY_STORAGE_HOST`: the zone's supported regional host; default `storage.bunnycdn.com`.

Reuse the existing zone and permissions; do not create a public pull zone for RFQ files. Upload/delete must be permitted for the storage key. No new server dependency or media worker is required. The client adds the approved `three` and `@types/three` packages with the updated lockfile.

```bash
# imet-server
npm ci
npm run db:generate
npm run db:validate
npm run db:deploy
npx prisma migrate status
npm run typecheck
npm run lint
npm run build
npm test
npm start
npm run worker:rfq:prod # existing maintenance, separate session

# imet-client
npm ci
npm run type-check
npm run lint
npm run build
npm start
```

Preserve selected branches and local environment files. Never reset production databases or delete Docker volumes. Run both M9 migrations before the new server; repeated deployment must report no pending migrations. WebXR headset use requires HTTPS and a compatible browser/device. Configure reverse-proxy upload limits/timeouts to allow the 25 MB multipart request without changing application limits.

## Validation

The complete backend suite passed **64 tests**, zero failures/skips, including M0–M8 regressions and M9 format, actual DB/API authorization, source preservation, privacy, size/hash mismatch, state recovery, storage failures and migration constraints. Backend types/lint/build and Prisma status/diff passed; eleven migrations are current with no schema drift. Client locked installation, strict types, lint and production build passed. Normal production startup passed missing-storage guidance/disabled upload and standard catalogue checks. The RFQ maintenance job completed through Redis; API database readiness passed. Task fixtures were removed and normal services restored without mock preloads or credentials.

Browser checks passed at **390, 820 and 1440 pixels** for real WebGL GLB rendering, keyboard rotation changing rendered pixels, zoom/reset, panorama mouse/touch interaction, actual admin upload/preview/delete, lazy asset requests, unsupported VR, mocked positive VR capability with session rejection, network retry and no-WebGL standard-image fallback. Test assets and users were cleaned. Bunny transport was mocked; no live storage credential or physical headset was available. These tests do not establish live Bunny delivery, actual headset usability or every browser/GPU combination. Device VR and a representative real machinery asset should be checked after storage credentials are configured.
