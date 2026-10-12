import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client.js';
import { config } from './env.js';

const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,

  // Connection pool
  max: 10,
  min: 0,

  // Timeouts
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  query_timeout: 30000,

  // Keep connections alive
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

export const prisma = new PrismaClient({
  adapter,
  log: ['warn', 'error'],
});

export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
