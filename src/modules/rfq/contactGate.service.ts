import type { Prisma } from '../../generated/client.js';
import { effectiveState } from '../subscription/subscription.entitlements.js';
export async function contactGate(
  tx: Prisma.TransactionClient,
  rfqId: string,
  recipientUserId: string,
) {
  const rfq = await tx.rfq.findUnique({
    where: { id: rfqId },
    select: { status: true, isFlagged: true },
  });
  if (!rfq || !['ACCEPTED', 'CLOSED'].includes(rfq.status) || rfq.isFlagged)
    return null;
  const quote = await tx.rfqQuote.findFirst({
    where: {
      rfqId,
      status: 'ACCEPTED',
      recipient: { recipientId: recipientUserId, removedAt: null },
    },
  });
  if (!quote) return null;
  const supplier = await tx.supplier.findUnique({
    where: { userId: recipientUserId },
    include: {
      subscriptions: { where: { isCurrent: true } },
      user: {
        select: {
          status: true,
          isEmailVerified: true,
          assignedRole: { select: { role: true } },
        },
      },
    },
  });
  const term = supplier?.subscriptions[0];
  if (
    !supplier ||
    supplier.status !== 'APPROVED' ||
    supplier.contactBlocked ||
    supplier.user.status !== 'ACTIVE' ||
    !supplier.user.isEmailVerified ||
    !supplier.user.assignedRole.some(
      (r) =>
        r.role ===
        (supplier.type === 'LOCAL'
          ? 'LOCAL_SUPPLIER'
          : 'INTERNATIONAL_MANUFACTURER'),
    ) ||
    !term ||
    effectiveState(term) !== 'ACTIVE' ||
    term.supplierType !== supplier.type ||
    !term.rfqEnabled ||
    !term.canRevealContacts
  )
    return null;
  return {
    contactName: supplier.contactName,
    email: supplier.businessEmail,
    phone: supplier.businessPhone,
    address: supplier.address,
  };
}
