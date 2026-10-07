import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { config } from '../config/env.js';
import { prisma } from '../config/database.js';
import type { Prisma } from '../generated/client.js';
import { getEmailQueue, type EmailJob } from './queue.js';
import { authEmail, authEmailText } from './templates/authEmail.js';
import type { EmailProvider } from '../modules/notification/notification.jobs.js';
const key = createHash('sha256')
  .update(`imet-auth-email-v1:${config.JWT_SECRET}`)
  .digest();
export function encrypt(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decrypt(value: string) {
  const bytes = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString('utf8');
}
export function recordAuthEmail(
  tx: Prisma.TransactionClient,
  userId: string,
  purpose: 'verify-user' | 'reset-password',
  token: { raw: string; hash: string },
  expiresAt: Date,
) {
  return tx.authEmailIntent.create({
    data: {
      userId,
      purpose,
      tokenHash: token.hash,
      encryptedToken: encrypt(token.raw),
      expiresAt,
    },
  });
}
async function prepare(id: string) {
  const row = await prisma.authEmailIntent.findUnique({
    where: { id },
    include: { user: true },
  });
  if (!row || row.sentAt || row.expiresAt <= new Date()) return null;
  const valid =
    row.purpose === 'verify-user'
      ? ['PENDING_VERIFICATION', 'PENDING'].includes(row.user.status) &&
        !row.user.isEmailVerified &&
        row.user.emailVerificationTokenHash === row.tokenHash
      : ['ACTIVE', 'PENDING'].includes(row.user.status) &&
        row.user.isEmailVerified &&
        row.user.passwordResetTokenHash === row.tokenHash;
  if (!valid) return null;
  const action =
    row.purpose === 'verify-user'
      ? 'Verify your email address'
      : 'Reset your password';
  const link = new URL(`/auth/${row.purpose}`, config.FRONTEND_URL);
  link.searchParams.set('token', decrypt(row.encryptedToken));
  return {
    to: row.user.email,
    subject: `${action} — iMet Machinery`,
    html: authEmail(row.user.displayName, action, link.toString()),
    text: authEmailText(row.user.displayName, action, link.toString()),
    authIntentId: id,
  } satisfies EmailJob;
}
export async function dispatchAuthEmails(userId?: string) {
  const rows = await prisma.authEmailIntent.findMany({
    where: {
      sentAt: null,
      expiresAt: { gt: new Date() },
      ...(userId ? { userId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  for (const row of rows) {
    try {
      const data = await prepare(row.id);
      if (!data) {
        await prisma.authEmailIntent.deleteMany({ where: { id: row.id } });
        continue;
      }
      const queue = getEmailQueue();
      const old = await queue.getJob(row.id);
      if (old && (await old.getState()) === 'failed') await old.retry();
      else if (!old) await queue.add('authentication', data, { jobId: row.id });
    } catch {
      /* Stop this batch on queue failure; the worker retries the committed intents. */
      break;
    }
  }
  await prisma.authEmailIntent.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });
}
export async function deliverAuthEmail(id: string, provider: EmailProvider) {
  const data = await prepare(id);
  if (!data) return { suppressed: true };
  const result = await provider.send(data, id);
  await prisma.authEmailIntent.updateMany({
    where: { id, sentAt: null },
    data: { sentAt: new Date(), encryptedToken: '' },
  });
  return result;
}
