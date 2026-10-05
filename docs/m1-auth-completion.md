# M1 authentication completion

This follow-up changes authentication/account settings only. Catalogue, supplier, subscription, storage and M2–M4 business contracts remain unchanged. Shared header/layout changes concern signed-in navigation and preserving authentication return paths. AloSkill remains read-only. No dependencies are added.

## Behavior

- Google uses the existing NextAuth Google provider with PKCE, state and nonce. The API independently verifies the ID-token RS256 signature against Google's JWKS, issuer, audience/authorized party, expiry, issue time and verified email. Raw Google IDs/emails are never trusted as authentication.
- A new Google identity gets only the configured public Buyer role and an ACTIVE verified account. Its password hash is generated from an unguessable random value; no usable password is returned or seeded. Forgot/reset password allows the verified owner to establish a credentials password. Existing password authentication and role/status guards remain intact.
- Existing email/password accounts are not silently linked. Sign in with the password, then select Link / sign in with Google in account settings using the same verified email. An existing identity cannot be reassigned. Suspended/inactive/unverified accounts cannot sign in or link.
- Signup still fails closed if PUBLIC_SIGNUP_ROLE is absent. Explicitly configure BUYER; do not grant supplier/admin roles through public signup. This approved setting was restored in the local ignored server .env.
- Signup, resend and forgot-password commit encrypted auth email intents in the same PostgreSQL transaction as user/token changes. Queue failure cannot discard the intent. The existing email worker recovers intents every 15 seconds. Stable BullMQ/provider IDs prevent ordinary duplicates; superseded/expired/status-ineligible links are suppressed at delivery. Verification/reset tokens remain hashed, expiring and single-use. Delivered/expired token payloads are cleared/deleted.
- Auth rate counters use the existing Redis connection settings across API replicas. Google subjects are used only as rate-limit buckets; identity is still verified separately. General catalogue rate limiting is unchanged. Trust-proxy settings must match the actual deployment; no arbitrary forwarded-header trust is enabled.
- NextAuth uses /auth/refresh-coordinated for simultaneous replica refreshes. A five-second encrypted database handoff returns one rotation to racing callers only while the session/current refresh hash and live account remain eligible. The existing /auth/refresh API retains strict single-use semantics. Revocation/password/status changes override the handoff. Expired handoffs are pruned on successful coordinated refresh.
- All password-bearing auth/account inputs have accessible show/hide controls. M1 requests have 15-second deadlines. Profile updates refresh live server/session identity; failed account loading terminates with retry/sign-in controls. M1 forms map validation errors, and access management rejects zero selected roles locally. Protected return URLs are local and validated; OAuth secrets remain server-only.

## Configuration / deployment

Apply the two additive migrations with `npm run db:generate` and `npm run db:deploy` against the intended PostgreSQL database. Do not reset it. On the current M12 baseline there are sixteen migrations. Existing user/password/role data is preserved.

API/email worker:

```dotenv
PUBLIC_SIGNUP_ROLE=BUYER
GOOGLE_CLIENT_ID=<Google web OAuth client ID>
RESEND_FROM_EMAIL=<verified sender address>
# Secure environment settings only:
RESEND_API_KEY=<secret>
```

NextAuth server (imet-client):

```dotenv
GOOGLE_CLIENT_ID=<same Google web OAuth client ID>
GOOGLE_CLIENT_SECRET=<secret; never NEXT_PUBLIC_>
NEXTAUTH_URL=<actual frontend origin>
```

Register `<NEXTAUTH_URL>/api/auth/callback/google` as the Google web-client redirect URI. Configure authorized origins for the deployed origin and intended local development origin. Preserve existing JWT_SECRET/NEXTAUTH_SECRET, frontend API URLs and database/Redis settings. JWT_SECRET must match API/email worker; rotating it invalidates outstanding encrypted intents/handoffs. Do not paste keys in chat or source files.

Allow `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com` and `api.resend.com` in cloud egress. In this Node 24 cloud, use `NODE_USE_ENV_PROXY=1 npm start` for both applications and `NODE_USE_ENV_PROXY=1 npm run worker:prod` for mail when HTTP(S)_PROXY is supplied. Never disable TLS verification. The environment draft preserves previous provider domains and adds these requirements/startup instructions; saving the draft does not apply or publish it.

Start the existing email worker after securely configuring Resend. Redis being reachable or an email job being queued does not establish inbox delivery. Existing RFQ maintenance worker startup is unchanged.

## Validation

Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, migration status and no-drift checks in imet-server; run `npm run type-check`, `npm run lint`, `npm run build` in imet-client. Existing auth lifecycle tests remain, with additional signed-token/Google-linking/status/concurrency/durable-mail/rate-limit tests in tests/auth-gaps.test.ts. The signup-policy test loads dotenv before removing policy so it genuinely tests an absent policy even when the local runtime correctly enables Buyer registration.

Production-browser fixture scripts and screenshots are in `/workspace/artifacts/m1-auth`. They use temporary accounts, real PostgreSQL/Redis/BullMQ, a controlled email provider, and controlled Google upstream discovery/token/JWKS responses. Wrong state/nonce must fail before account creation; successful callbacks must create real iMet sessions. QA preload hooks and fake OAuth credentials are never part of normal startup.

Live Google consent/code exchange and actual Resend inbox delivery remain external verification steps until secure credentials and egress configuration are supplied. Controlled fixtures prove integration paths, not live provider operation.
