import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client.js';
import { config } from './env.js';
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 3000,
  query_timeout: 3000,
});
export const prisma = new PrismaClient({ adapter });
export async function checkDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
