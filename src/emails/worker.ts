import { prisma, disconnectDatabase } from '../config/database.js';
import { config } from '../config/env.js';
import { Worker } from 'bullmq';
import { createRedisConnection } from './redisConnection.js';
import { ResendProvider } from './providers/resendProvider.js';
import type { EmailJob } from './queue.js';
const provider = new ResendProvider();
const connection = createRedisConnection('worker');
const worker = new Worker<EmailJob>(
  config.EMAIL_QUEUE_NAME,
  async (job) => {
    try {
      const sent = await provider.send(job.data, job.id!);
      if (job.data.rfqDeliveryId)
        await prisma.rfqEmailDelivery.update({
          where: { id: job.data.rfqDeliveryId },
          data: { status: 'SENT', sentAt: new Date(), lastError: null },
        });
      return sent;
    } catch (error) {
      if (job.data.rfqDeliveryId)
        await prisma.rfqEmailDelivery.update({
          where: { id: job.data.rfqDeliveryId },
          data: { lastError: 'Resend delivery failed' },
        });
      throw error;
    }
  },
  { connection, concurrency: 5 },
);
worker.on('failed', (job) => {
  console.error('Email job failed', { jobId: job?.id });
  if (job?.data.rfqDeliveryId && job.attemptsMade >= (job.opts.attempts ?? 1))
    void prisma.rfqEmailDelivery
      .updateMany({
        where: { id: job.data.rfqDeliveryId, status: { not: 'SENT' } },
        data: {
          status: 'FAILED',
          lastError: 'Email delivery exhausted retries',
        },
      })
      .catch(() => console.error('Could not persist email delivery failure'));
});
worker.on('error', () => console.error('Email worker connection error'));
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await worker.close();
  await connection.quit();
  await disconnectDatabase();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
