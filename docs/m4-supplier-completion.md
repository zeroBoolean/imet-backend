# M4 supplier completion

This increment completes the audited supplier/subscription gaps. Existing approval, plan assignment, renewal, cancellation, expiry and accepted-quote contact rules remain in place. Buyers do not need subscriptions and no payment processing is introduced.

## Connected workflows

- Registered users upload a company logo and private PDF/JPEG/PNG verification documents with their application. Rejected applicants can resubmit. Approved owners edit permitted profile fields and their logo; verification documents and sensitive company identity fields remain admin-controlled.
- Administrators review managed documents using authenticated downloads, edit profiles, approve/reject/suspend/deactivate, create their own prices/durations/limits and manually assign or renew terms. Rejection reasons and subscription date/plan errors appear beside the fields.
- Entitled suppliers upload ordinary machinery images using the existing catalogue upload lifecycle. The machinery workspace displays listing usage and the editor applies current image/specification ceilings. The backend remains authoritative for all direct create/edit/publish/delete requests.
- Public supplier and machinery responses keep explicit safe projections. Contacts remain available only through the existing accepted-winning-quote gate, with live account, supplier and contact entitlement checks. Expired, suspended, cancelled, future, mismatched-type or contact-disabled terms cannot reveal private contacts.

## Storage and deployment

Apply migrations with `npm run db:deploy`, regenerate the Prisma client and build normally. Migration `20261005130000_m4_supplier_assets` adds upload metadata and an optional logo reference; it preserves existing external URLs and document JSON.

Use the existing **backend-only** `BUNNY_STORAGE_ZONE`, `BUNNY_STORAGE_ACCESS_KEY` and `BUNNY_STORAGE_HOST` settings. The supplier namespace shares the existing Bunny service with catalogue media and private RFQ attachments. Do not expose a whole-zone public pull URL: private documents are delivered through authenticated backend endpoints, not signed tokens in query strings or raw Bunny URLs. No storage key belongs in the client environment.

Run the existing `npm run worker:catalogue:prod` alongside the API. It now retries cleanup of replaced/removed supplier files and reclaims abandoned uploads, as well as catalogue images. Uploaded files reserve metadata before storage writes and failures retain retryable deletion state. Unattached active uploads expire after 24 hours; interrupted uploads after one hour. Uploads are limited to 10 MB, logos to validated JPEG/PNG, documents to PDF/JPEG/PNG and at most 20 documents per application. Managed image content is validated for type, dimensions and completeness; PDF files require a final EOF marker. File delivery verifies stored size/hash and rechecks access after storage I/O.

The specification does not mandate certificate types or country-specific verification documents. Administrators review the supplied information; no invented mandatory certificate checklist is imposed. Approval itself remains an explicit administrative decision.

## Verification

The full regression suite passes 107 tests. Both repositories pass production builds, strict TypeScript and ESLint; Prisma reports no schema drift.

API tests cover owned/staged/bound files, guessed IDs, anonymous and unrelated-user denial, private document isolation, publication/expiry, failed-write rollback, cleanup retry, session revocation during upload and visibility revocation during download. Existing supplier/subscription tests cover approvals, concurrency, listing quotas, renewals, plan snapshots and suspension. RFQ tests additionally exercise accepted-contact denial across term/account/profile restrictions without requiring a buyer subscription.

Browser checks exercise application and managed-file upload/download, admin review/plan/activation, supplier machinery publication and plan ceilings, public logo/image delivery, replacement cleanup and expiry. Responsive application screens are checked at 390, 820 and 1440 pixels.

Bunny transport is emulated in automated verification when real provider credentials are unavailable; real-zone connectivity must be verified with deployment secrets. The emulator is an external QA artifact and is not used by normal startup.
