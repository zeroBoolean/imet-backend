import { randomBytes, createHash } from 'node:crypto';
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export const newToken = () => {
  const raw = randomBytes(32).toString('hex');
  return { raw, hash: tokenHash(raw) };
};
export const expiresIn = (minutes: number) =>
  new Date(Date.now() + minutes * 60_000);
