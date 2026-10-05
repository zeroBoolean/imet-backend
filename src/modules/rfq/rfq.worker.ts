import { dispatchNotificationEmails } from '../notification/notification.jobs.js';
import { Queue, Worker } from 'bullmq';
import { createRedisConnection } from '../../emails/redisConnection.js';
import { config } from '../../config/env.js';
import { expireRfqs, dispatchRfqEmails } from './rfq.jobs.js';
import { disconnectDatabase } from '../../config/database.js';
import { closeEmailQueue } from '../../emails/queue.js';
const connection = createRedisConnection('worker');
const queue = new Queue(`${config.EMAIL_QUEUE_NAME}-rfq-maintenance`, {
  connection,
});
await queue.upsertJobScheduler(
  'rfq-maintenance',
  { every: 60000 },
  {
    name: 'maintenance',
    data: {},
    opts: { removeOnComplete: true, removeOnFail: 100 },
  },
);
const worker = new Worker(
  `${config.EMAIL_QUEUE_NAME}-rfq-maintenance`,
  async () => {
    await expireRfqs();
    await dispatchRfqEmails();
    await dispatchNotificationEmails('service');
  },
  { connection, concurrency: 1 },
);
worker.on('error', () => console.error('RFQ worker connection error'));
worker.on('failed', () => console.error('RFQ maintenance failed'));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker.close();
  await queue.close();
  await closeEmailQueue();
  await connection.quit();
  await disconnectDatabase();
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
