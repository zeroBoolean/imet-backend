import { config } from '../config/env.js';
import { Queue } from 'bullmq';
import { createRedisConnection } from './redisConnection.js';
export interface EmailJob {
  to: string;
  subject: string;
  html: string;
  rfqDeliveryId?: string;
}
let queue: Queue<EmailJob> | undefined;
export const getEmailQueue = () =>
  (queue ??= new Queue<EmailJob>(config.EMAIL_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: { age: 86400, count: 100 },
    },
  }));
export const closeEmailQueue = async () => {
  if (queue) {
    const client = await queue.client;
    await queue.close();
    await client.quit();
    queue = undefined;
  }
};
