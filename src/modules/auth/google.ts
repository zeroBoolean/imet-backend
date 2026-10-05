import { createPublicKey, type JsonWebKey } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { AppError } from '../../middleware/errorHandler.js';
const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  email_verified: z.literal(true),
  name: z.string().trim().min(1).max(100).optional(),
  exp: z.number(),
  iat: z.number(),
  aud: z.string(),
  azp: z.string().optional(),
});
let cache: { keys: JsonWebKey[]; until: number } | undefined;
export async function verifyGoogleIdentity(idToken: string) {
  if (!config.GOOGLE_CLIENT_ID)
    throw new AppError('Google Sign-In is currently unavailable', 503);
  try {
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || decoded.header.alg !== 'RS256' || !decoded.header.kid)
      throw new Error();
    if (
      !cache ||
      cache.until < Date.now() ||
      !cache.keys.some((key) => key.kid === decoded.header.kid)
    ) {
      const response = await fetch(
        'https://www.googleapis.com/oauth2/v3/certs',
        { signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error();
      const body = (await response.json()) as { keys: JsonWebKey[] };
      cache = { keys: body.keys, until: Date.now() + 3600000 };
    }
    const key = cache.keys.find(
      (key) =>
        key.kid === decoded.header.kid &&
        key.kty === 'RSA' &&
        key.use === 'sig',
    );
    if (!key) throw new Error();
    const publicKey = createPublicKey({ key, format: 'jwk' });
    const claims = claimsSchema.parse(
      jwt.verify(idToken, publicKey, {
        algorithms: ['RS256'],
        audience: config.GOOGLE_CLIENT_ID,
        issuer: ['accounts.google.com', 'https://accounts.google.com'],
        maxAge: '1h',
      }),
    );
    if (claims.iat > Math.floor(Date.now() / 1000) + 60) throw new Error();
    if (claims.azp && claims.azp !== config.GOOGLE_CLIENT_ID) throw new Error();
    return {
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      displayName: claims.name || claims.email.split('@')[0],
    };
  } catch {
    throw new AppError('Invalid or expired Google credential', 401);
  }
}
