import type { Prisma, UserRole } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
export interface Actor {
  id: string;
  roles: UserRole[];
}
export const isAdmin = (a: Actor) => a.roles.includes('ADMIN');
export const terminal = ['CLOSED', 'CANCELLED', 'EXPIRED', 'DECLINED'] as const;
export async function lockRfq(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM rfqs WHERE id = ${id} FOR UPDATE`;
  const rfq = await tx.rfq.findUnique({ where: { id } });
  if (!rfq) throw new AppError('RFQ not found', 404);
  return rfq;
}
export async function rfqAccess(
  tx: Prisma.TransactionClient,
  id: string,
  actor: Actor,
) {
  const rfq = await tx.rfq.findUnique({ where: { id } });
  if (!rfq) throw new AppError('RFQ not found', 404);
  if (
    !isAdmin(actor) &&
    rfq.buyerId !== actor.id &&
    !(await tx.rfqRecipient.findFirst({
      where: { rfqId: id, recipientId: actor.id, removedAt: null },
    }))
  )
    throw new AppError('RFQ not found', 404);
  return rfq;
}
export const checkVersion = (date: Date, version: string) => {
  if (date.toISOString() !== version)
    throw new AppError('Record changed. Reload before saving', 409);
};
export const touch = (date: Date) =>
  new Date(Math.max(Date.now(), date.getTime() + 1));
export async function requireOpen(tx: Prisma.TransactionClient, id: string) {
  const rfq = await lockRfq(tx, id);
  if (
    !['ROUTED', 'QUOTED'].includes(rfq.status) ||
    (rfq.expiresAt && rfq.expiresAt <= new Date()) ||
    rfq.isFlagged
  )
    throw new AppError('RFQ is not open for responses', 409);
  return rfq;
}
