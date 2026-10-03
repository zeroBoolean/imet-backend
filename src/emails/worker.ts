import { config } from '../config/env.js';
import { Worker } from 'bullmq';
import { createRedisConnection } from './redisConnection.js';
import { ResendProvider } from './providers/resendProvider.js';
import type { EmailJob } from './queue.js';
const provider = new ResendProvider();
const connection = createRedisConnection('worker');
const worker = new Worker<EmailJob>(
  config.EMAIL_QUEUE_NAME,
  (job) => provider.send(job.data, job.id!),
  { connection, concurrency: 5 },
);
worker.on('failed', (job) =>
  console.error('Email job failed', { jobId: job?.id }),
);
worker.on('error', () => console.error('Email worker connection error'));
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await worker.close();
  await connection.quit();
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
