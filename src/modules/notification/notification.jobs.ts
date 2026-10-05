import { prisma } from '../../config/database.js';
import type { Prisma, RfqEmailStatus } from '../../generated/client.js';
import { getEmailQueue, type EmailJob } from '../../emails/queue.js';
import {
  prepareNotificationEmail,
  type DeliveryKind,
} from './notification.service.js';

type DeliveryWhere = {
  status?: RfqEmailStatus | { in: RfqEmailStatus[] };
  attempts?: { lt: number };
  sendAttempts?: { lt: number };
  dispatchLeaseUntil?: null | { lte: Date };
  queuedAt?: { lte: Date };
  OR?: DeliveryWhere[];
  AND?: DeliveryWhere[];
};
type DeliveryUpdate = Pick<
  Prisma.RfqEmailDeliveryUpdateManyMutationInput,
  | 'status'
  | 'attempts'
  | 'sendAttempts'
  | 'firstAttemptAt'
  | 'providerMessageId'
  | 'dispatchLeaseUntil'
  | 'lastError'
  | 'queuedAt'
  | 'sentAt'
>;

const maximumAttempts = 5;
// Resend's idempotency retention is finite. Never blindly resend an old ambiguous attempt.
export const safeRetryWindowMs = 23 * 60 * 60 * 1000;
const deliverySelect = {
  id: true,
  status: true,
  attempts: true,
  sendAttempts: true,
  firstAttemptAt: true,
  providerMessageId: true,
  dispatchLeaseUntil: true,
} satisfies Prisma.RfqEmailDeliverySelect;
export const readDelivery = (kind: DeliveryKind, id: string) =>
  kind === 'service'
    ? prisma.notificationEmailDelivery.findUnique({
        where: { id },
        select: deliverySelect,
      })
    : prisma.rfqEmailDelivery.findUnique({
        where: { id },
        select: deliverySelect,
      });
export function updateDelivery(
  kind: DeliveryKind,
  id: string,
  data: DeliveryUpdate,
  where: DeliveryWhere = {},
) {
  return kind === 'service'
    ? prisma.notificationEmailDelivery.updateMany({
        where: { ...where, id },
        data,
      })
    : prisma.rfqEmailDelivery.updateMany({ where: { ...where, id }, data });
}
const live = { status: { in: ['PENDING', 'QUEUED', 'FAILED'] as const } };
const liveWhere: DeliveryWhere = {
  status: { in: [...live.status.in] },
};
async function suppress(kind: DeliveryKind, id: string) {
  await updateDelivery(
    kind,
    id,
    {
      status: 'SUPPRESSED',
      lastError: 'Recipient no longer authorized',
      dispatchLeaseUntil: null,
    },
    liveWhere,
  );
}
async function requireReview(kind: DeliveryKind, id: string) {
  await updateDelivery(
    kind,
    id,
    {
      status: 'REVIEW_REQUIRED',
      lastError: 'Ambiguous delivery is outside the safe retry window',
      dispatchLeaseUntil: null,
    },
    liveWhere,
  );
}
export async function dispatchDelivery(
  kind: DeliveryKind,
  id: string,
  now = new Date(),
) {
  // Database lease coordinates multiple maintenance processes, without holding a transaction over Redis calls.
  const claimed = await updateDelivery(
    kind,
    id,
    { dispatchLeaseUntil: new Date(now.getTime() + 60000) },
    {
      ...liveWhere,
      OR: [{ dispatchLeaseUntil: null }, { dispatchLeaseUntil: { lte: now } }],
    },
  );
  if (!claimed.count) return;
  let consumedAttempt = false;
  try {
    const row = await readDelivery(kind, id);
    if (!row) return;
    const queue = getEmailQueue();
    const job = await queue.getJob(id);
    const state = job ? await job.getState() : null;
    if (state === 'completed') {
      const result: unknown = job?.returnvalue;
      if (
        typeof result === 'object' &&
        result !== null &&
        'id' in result &&
        typeof result.id === 'string'
      ) {
        await updateDelivery(
          kind,
          id,
          {
            status: 'SENT',
            providerMessageId: result.id,
            sentAt: now,
            lastError: null,
          },
          liveWhere,
        );
        return;
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        'suppressed' in result &&
        result.suppressed === true
      ) {
        await suppress(kind, id);
        return;
      }
      await requireReview(kind, id);
      return;
    }
    if (state && state !== 'failed' && state !== 'unknown') {
      await updateDelivery(
        kind,
        id,
        { status: 'QUEUED', queuedAt: now, lastError: null },
        liveWhere,
      );
      return;
    }
    if (
      row.firstAttemptAt &&
      now.getTime() - row.firstAttemptAt.getTime() >= safeRetryWindowMs
    ) {
      await requireReview(kind, id);
      return;
    }
    if (
      row.sendAttempts >= maximumAttempts ||
      row.attempts >= maximumAttempts
    ) {
      await updateDelivery(
        kind,
        id,
        { status: 'FAILED', lastError: 'Email delivery exhausted retries' },
        liveWhere,
      );
      return;
    }
    const email = await prepareNotificationEmail(kind, id);
    if (!email) {
      await suppress(kind, id);
      return;
    }
    // Consume dispatch attempts before Redis, so queue errors cannot cause an unbounded loop.
    await updateDelivery(
      kind,
      id,
      { attempts: { increment: 1 }, queuedAt: now },
      liveWhere,
    );
    consumedAttempt = true;
    if (state === 'failed' && job) await job.retry();
    else
      await queue.add(kind === 'service' ? 'notification' : 'rfq', email, {
        jobId: id,
        removeOnComplete: false,
        removeOnFail: false,
      });
    await updateDelivery(
      kind,
      id,
      { status: 'QUEUED', lastError: null },
      liveWhere,
    );
  } catch {
    if (!consumedAttempt)
      await updateDelivery(
        kind,
        id,
        { attempts: { increment: 1 } },
        { ...liveWhere, attempts: { lt: maximumAttempts } },
      );
    await updateDelivery(
      kind,
      id,
      { status: 'FAILED', lastError: 'Email dispatch failed' },
      liveWhere,
    );
  } finally {
    await updateDelivery(kind, id, { dispatchLeaseUntil: null });
  }
}
export async function dispatchNotificationEmails(
  kind: DeliveryKind,
  now = new Date(),
) {
  const where: DeliveryWhere = {
    OR: [
      {
        status: { in: ['PENDING', 'FAILED'] },
        attempts: { lt: maximumAttempts },
        sendAttempts: { lt: maximumAttempts },
      },
      {
        status: 'QUEUED',
        queuedAt: { lte: new Date(now.getTime() - 5 * 60000) },
      },
    ],
    AND: [
      {
        OR: [
          { dispatchLeaseUntil: null },
          { dispatchLeaseUntil: { lte: now } },
        ],
      },
    ],
  };
  const rows =
    kind === 'service'
      ? await prisma.notificationEmailDelivery.findMany({
          where,
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 100,
        })
      : await prisma.rfqEmailDelivery.findMany({
          where,
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: 100,
        });
  for (const row of rows) await dispatchDelivery(kind, row.id, now);
  return rows.length;
}
export interface EmailProvider {
  send(email: EmailJob, id: string): Promise<{ id: string }>;
}
export async function deliverEmail(
  data: EmailJob,
  jobId: string,
  provider: EmailProvider,
  now = new Date(),
) {
  if (data.notificationDeliveryId && data.rfqDeliveryId)
    throw new Error('Invalid email delivery reference');
  const kind: DeliveryKind = data.notificationDeliveryId ? 'service' : 'rfq';
  const id = data.notificationDeliveryId ?? data.rfqDeliveryId;
  if (!id) return provider.send(data, jobId); // Existing authentication payloads remain compatible.
  if (id !== jobId) throw new Error('Invalid email delivery identity');
  const row = await readDelivery(kind, id);
  if (!row || row.status === 'SUPPRESSED') return { suppressed: true };
  if (row.status === 'SENT') {
    if (row.providerMessageId) return { id: row.providerMessageId };
    return { suppressed: true }; // Legacy accepted RFQ rows have no provider ID; never resend them.
  }
  if (row.status === 'REVIEW_REQUIRED') return { suppressed: true };
  if (
    row.firstAttemptAt &&
    now.getTime() - row.firstAttemptAt.getTime() >= safeRetryWindowMs
  ) {
    await requireReview(kind, id);
    return { suppressed: true };
  }
  const email = await prepareNotificationEmail(kind, id);
  if (!email) {
    await suppress(kind, id);
    return { suppressed: true };
  }
  if (row.sendAttempts >= maximumAttempts) {
    await updateDelivery(
      kind,
      id,
      { status: 'FAILED', lastError: 'Email delivery exhausted retries' },
      liveWhere,
    );
    throw new Error('Email delivery exhausted retries');
  }
  const attempted = await updateDelivery(
    kind,
    id,
    {
      sendAttempts: { increment: 1 },
      firstAttemptAt: row.firstAttemptAt ?? now,
    },
    { ...liveWhere, sendAttempts: { lt: maximumAttempts } },
  );
  if (!attempted.count) return { suppressed: true };
  let sent: { id: string };
  try {
    sent = await provider.send(email, id);
  } catch {
    const current = await readDelivery(kind, id);
    await updateDelivery(
      kind,
      id,
      {
        ...(current && current.sendAttempts >= maximumAttempts
          ? { status: 'FAILED' }
          : {}),
        lastError: 'Resend delivery failed',
      },
      liveWhere,
    );
    throw new Error('Transactional email delivery failed');
  }
  try {
    await updateDelivery(
      kind,
      id,
      {
        status: 'SENT',
        sentAt: now,
        providerMessageId: sent.id,
        lastError: null,
      },
      liveWhere,
    );
  } catch {
    // Keep the successful result in the retained BullMQ job; maintenance can reconcile it without resending.
    console.error('Could not persist accepted email delivery', {
      deliveryId: id,
    });
  }
  return sent;
}
