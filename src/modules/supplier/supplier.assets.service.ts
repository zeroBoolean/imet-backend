import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../config/database.js';
import type { Prisma, SupplierAssetPurpose } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { bunnyStorage } from '../../services/bunnyStorage.js';
import { validateCatalogueImage } from '../catalogue/catalogue.images.service.js';
import { validateAttachment } from '../rfq/rfqAttachment.service.js';
import { publicSupplierWhere } from '../subscription/subscription.entitlements.js';
export const supplierAssetPath = (id: string, purpose: SupplierAssetPurpose) =>
  purpose === 'LOGO'
    ? `/suppliers/assets/${id}/logo`
    : `/supplier/assets/${id}/content`;
export async function supplierAssetAccess(
  userId: string,
  sessionId?: string,
  purpose?: SupplierAssetPurpose,
) {
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      status: { in: ['ACTIVE', 'PENDING'] },
      isEmailVerified: true,
      ...(sessionId
        ? {
            sessions: {
              some: {
                id: sessionId,
                revokedAt: null,
                expiresAt: { gt: new Date() },
              },
            },
          }
        : {}),
    },
    include: { assignedRole: true, supplier: true },
  });
  if (!user) throw new AppError('Account access required', 403);
  const admin = user.assignedRole.some((r) => r.role === 'ADMIN');
  if (
    purpose &&
    !admin &&
    user.supplier &&
    !(
      (user.status === 'PENDING' && user.supplier.status === 'PENDING') ||
      user.supplier.status === 'REJECTED' ||
      (user.supplier.status === 'APPROVED' && purpose === 'LOGO')
    )
  )
    throw new AppError('This profile does not permit this upload', 403);
  return { user, admin };
}
export async function bindSupplierAssets(
  tx: Prisma.TransactionClient,
  supplierId: string,
  actorId: string | undefined,
  data: {
    logoUrl: string | null;
    logoAssetId?: string | null;
    documents?: { name: string; url: string; assetId?: string }[];
  },
) {
  const old = await tx.supplier.findUniqueOrThrow({
    where: { id: supplierId },
  });
  const logoId =
    data.logoAssetId === undefined && data.logoUrl === old.logoUrl
      ? old.logoAssetId
      : (data.logoAssetId ?? null);
  if (
    logoId
      ? data.logoUrl !== supplierAssetPath(logoId, 'LOGO')
      : data.logoUrl?.startsWith('/')
  )
    throw new AppError('Logo upload reference does not match', 422);
  const docs =
    data.documents ??
    (old.documents as { name: string; url: string; assetId?: string }[]);
  const references = [
    ...(logoId ? [{ id: logoId, purpose: 'LOGO' as const }] : []),
    ...docs
      .filter((d) => d.assetId)
      .map((d) => ({ id: d.assetId!, purpose: 'DOCUMENT' as const })),
  ];
  if (new Set(references.map((r) => r.id)).size !== references.length)
    throw new AppError('Each upload may be used once', 422);
  for (const ref of [...references].sort((a, b) => a.id.localeCompare(b.id))) {
    await tx.$queryRaw`SELECT id FROM supplier_assets WHERE id=${ref.id} FOR UPDATE`;
    const asset = await tx.supplierAsset.findUnique({ where: { id: ref.id } });
    if (
      !asset ||
      asset.state !== 'ACTIVE' ||
      asset.purpose !== ref.purpose ||
      (asset.supplierId
        ? asset.supplierId !== supplierId
        : asset.ownerId !== actorId)
    )
      throw new AppError('Upload unavailable or owned by another profile', 422);
    await tx.supplierAsset.update({
      where: { id: ref.id },
      data: { supplierId },
    });
  }
  // Clear the restrictive logo relation before retiring replaced assets.
  if (old.logoAssetId !== logoId)
    await tx.supplier.update({
      where: { id: supplierId },
      data: { logoAssetId: null },
    });
  await tx.supplierAsset.updateMany({
    where: { supplierId, id: { notIn: references.map((r) => r.id) } },
    data: { supplierId: null, state: 'DELETING' },
  });
  return logoId;
}
export const supplierAssetService = {
  async upload(
    ownerId: string,
    sessionId: string,
    purpose: SupplierAssetPurpose,
    file: Express.Multer.File,
  ) {
    await supplierAssetAccess(ownerId, sessionId, purpose);
    if (!bunnyStorage.isConfigured())
      throw new AppError('Bunny file storage is not configured', 503);
    const raw =
      purpose === 'LOGO'
        ? await validateCatalogueImage(file.buffer)
        : await validateAttachment(file.buffer);
    const detected = {
      ext: raw.ext,
      fileType: 'fileType' in raw ? raw.fileType : raw.mime,
    };
    if (
      detected.fileType === 'application/pdf' &&
      !/%%EOF\s*$/.test(file.buffer.subarray(-1024).toString('latin1'))
    )
      throw new AppError('Upload a complete PDF document', 422);
    if (purpose === 'DOCUMENT' && detected.fileType !== 'application/pdf')
      await validateCatalogueImage(file.buffer);
    const id = randomUUID();
    const asset = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
      if (
        (await tx.supplierAsset.count({
          where: { ownerId, supplierId: null },
        })) >= 21
      )
        throw new AppError('Save or remove your unsaved uploads first', 422);
      return tx.supplierAsset.create({
        data: {
          id,
          ownerId,
          purpose,
          storageKey: `supplier/${ownerId}/${id}.${detected.ext}`,
          fileType: detected.fileType,
          fileName:
            file.originalname
              .split(/[\\/]/)
              .at(-1)!
              .split('')
              .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
              .join('')
              .slice(0, 250) || `file.${detected.ext}`,
          fileSize: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
        },
      });
    });
    try {
      await bunnyStorage.request(asset.storageKey, 'PUT', file.buffer);
      await supplierAssetAccess(ownerId, sessionId, purpose);
      const activated = await prisma.supplierAsset.updateMany({
        where: { id, state: 'UPLOADING' },
        data: { state: 'ACTIVE' },
      });
      if (!activated.count) throw new AppError('Upload interrupted', 409);
      return {
        assetId: id,
        url: supplierAssetPath(id, purpose),
        fileName: asset.fileName,
        fileType: asset.fileType,
      };
    } catch (error) {
      await prisma.supplierAsset.updateMany({
        where: { id },
        data: { state: 'DELETING' },
      });
      await this.cleanup([id]).catch(() => undefined);
      throw error;
    }
  },
  async remove(id: string, ownerId: string) {
    const changed = await prisma.supplierAsset.updateMany({
      where: {
        id,
        ownerId,
        supplierId: null,
        state: { in: ['ACTIVE', 'DELETING'] },
      },
      data: { state: 'DELETING' },
    });
    if (!changed.count) throw new AppError('Unattached upload not found', 404);
    await this.cleanup([id]);
    return { id };
  },
  async cleanup(ids?: string[]) {
    const assets = await prisma.supplierAsset.findMany({
      where: {
        supplierId: null,
        ...(ids ? { id: { in: ids } } : {}),
        OR: [
          { state: 'DELETING' },
          {
            state: 'UPLOADING',
            createdAt: { lt: new Date(Date.now() - 3600000) },
          },
          {
            state: 'ACTIVE',
            updatedAt: { lt: new Date(Date.now() - 86400000) },
          },
        ],
      },
      take: 100,
    });
    for (const asset of assets) {
      const claimed = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM supplier_assets WHERE id=${asset.id} FOR UPDATE`;
        return tx.supplierAsset.updateMany({
          where: {
            id: asset.id,
            supplierId: null,
            state: asset.state,
            updatedAt: asset.updatedAt,
          },
          data: { state: 'DELETING' },
        });
      });
      if (!claimed.count) continue;
      await bunnyStorage.request(asset.storageKey, 'DELETE');
      await prisma.supplierAsset.deleteMany({
        where: { id: asset.id, supplierId: null, state: 'DELETING' },
      });
    }
  },
  async content(id: string, userId?: string, sessionId?: string) {
    const check = async () => {
      const access = userId
        ? await supplierAssetAccess(userId, sessionId)
        : null;
      return prisma.supplierAsset.findFirst({
        where: {
          id,
          state: 'ACTIVE',
          ...(access
            ? {
                OR: [
                  { ownerId: userId, supplierId: null },
                  { supplier: { is: access.admin ? {} : { userId } } },
                ],
              }
            : { purpose: 'LOGO', logoFor: { is: publicSupplierWhere() } }),
        },
      });
    };
    const asset = await check();
    if (!asset) throw new AppError('File not found', 404);
    const response = await bunnyStorage.request(asset.storageKey, 'GET');
    if (!response.body) throw new AppError('File unavailable', 502);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > asset.fileSize) {
          await reader.cancel();
          throw new AppError('File content changed', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    if (
      length !== asset.fileSize ||
      createHash('sha256').update(buffer).digest('hex') !== asset.sha256
    )
      throw new AppError('File content changed', 502);
    if (!(await check())) throw new AppError('File not found', 404);
    return { buffer, fileType: asset.fileType, fileName: asset.fileName };
  },
};
