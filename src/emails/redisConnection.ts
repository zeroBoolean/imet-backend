import { Redis } from 'ioredis';
import { config } from '../config/env.js';
export const createRedisConnection = (
  role: 'producer' | 'worker' = 'producer',
) =>
  new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD || undefined,
    tls: config.REDIS_TLS ? {} : undefined,
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    connectTimeout: 10_000,
  });
