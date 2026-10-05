import { createHash, randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { bunnyStorage } from '../../services/bunnyStorage.js';
import { imageDimensions } from '../media/media.validation.js';
import { publicMachineWhere } from '../subscription/subscription.entitlements.js';
export const imagePath = (id: string) => `/catalogue/images/${id}/content`;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export async function validateCatalogueImage(buffer: Buffer) {
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES)
    throw new AppError('Upload a JPEG or PNG image up to 10 MB', 422);
  const detected = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (!detected || !['image/jpeg', 'image/png'].includes(detected.mime))
    throw new AppError(
      'Upload JPEG or PNG matching the file content; SVG and animated formats are not supported',
      422,
    );
  const { width, height } = imageDimensions(buffer, detected.mime);
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 32000000
  )
    throw new AppError(
      'Image dimensions exceed the 8192-pixel or 32-megapixel limit',
      422,
    );
  return {
    fileType: detected.mime,
    ext: detected.mime === 'image/png' ? 'png' : 'jpg',
  };
}
export async function bindCatalogueImages(
  tx: Prisma.TransactionClient,
  ids: string[],
  ownerId: string | undefined,
  machineId?: string,
) {
  if (new Set(ids).size !== ids.length)
    throw new AppError('Each uploaded image can appear only once', 422);
  for (const id of [...ids].sort()) {
    await tx.$queryRaw`SELECT id FROM catalogue_image_assets WHERE id=${id} FOR UPDATE`;
    const asset = await tx.catalogueImageAsset.findUnique({
      where: { id },
      include: { images: { select: { machineId: true } } },
    });
    if (
      !asset ||
      asset.state !== 'ACTIVE' ||
      (asset.images.length
        ? asset.images[0].machineId !== machineId
        : asset.ownerId !== ownerId)
    )
      throw new AppError(
        'Uploaded image is unavailable or belongs to another record',
        422,
      );
  }
}
export async function retireCatalogueImages(
  tx: Prisma.TransactionClient,
  ids: string[],
) {
  if (ids.length)
    await tx.catalogueImageAsset.updateMany({
      where: { id: { in: ids }, images: { none: {} } },
      data: { state: 'DELETING' },
    });
}
export const catalogueImageService = {
  async upload(ownerId: string, file: Express.Multer.File, sessionId?: string) {
    if (!bunnyStorage.isConfigured())
      throw new AppError('Bunny file storage is not configured', 503);
    const detected = await validateCatalogueImage(file.buffer),
      id = randomUUID();
    const asset = await prisma.$transaction(async (tx) => {
      // Serialize reservations per uploader so concurrent requests cannot bypass the staged quota.
      await tx.$queryRaw`SELECT id FROM users WHERE id=${ownerId} FOR UPDATE`;
      if (
        (await tx.catalogueImageAsset.count({
          where: { ownerId, images: { none: {} } },
        })) >= 20
      )
        throw new AppError(
          'At most 20 unsaved image uploads are allowed. Save or remove images first.',
          422,
        );
      return tx.catalogueImageAsset.create({
        data: {
          id,
          ownerId,
          storageKey: `catalogue/${ownerId}/${id}.${detected.ext}`,
          fileType: detected.fileType,
          fileName:
            file.originalname
              .split(/[\\/]/)
              .at(-1)!
              .split('')
              .filter(
                (character) =>
                  character.charCodeAt(0) >= 32 &&
                  character.charCodeAt(0) !== 127,
              )
              .join('')
              .slice(0, 250) || `image.${detected.ext}`,
          fileSize: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
        },
      });
    });
    try {
      await bunnyStorage.request(asset.storageKey, 'PUT', file.buffer);
      // Live role/session middleware gates the request; role is rechecked after storage I/O.
      await prisma.$transaction(async (tx) => {
        const admin = await tx.user.findFirst({
          where: {
            id: ownerId,
            status: 'ACTIVE',
            isEmailVerified: true,
            assignedRole: { some: { role: 'ADMIN' } },
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
        });
        if (!admin) throw new AppError('Administrator access required', 403);
        const activated = await tx.catalogueImageAsset.updateMany({
          where: { id, state: 'UPLOADING' },
          data: { state: 'ACTIVE' },
        });
        if (!activated.count)
          throw new AppError('Upload interrupted. Try again.', 409);
      });
      return {
        assetId: id,
        url: imagePath(id),
        fileName: asset.fileName,
        fileSize: asset.fileSize,
        fileType: asset.fileType,
      };
    } catch (error) {
      await prisma.catalogueImageAsset.updateMany({
        where: { id },
        data: { state: 'DELETING' },
      });
      await this.cleanup([id]).catch(() => undefined);
      throw error;
    }
  },
  async remove(id: string, ownerId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM catalogue_image_assets WHERE id=${id} FOR UPDATE`;
      const asset = await tx.catalogueImageAsset.findUnique({
        where: { id },
        include: { images: true },
      });
      if (!asset || asset.ownerId !== ownerId)
        throw new AppError('Image not found', 404);
      if (asset.images.length)
        throw new AppError(
          'Remove the image from its machine and save before deleting storage',
          409,
        );
      if (
        asset.state === 'UPLOADING' &&
        asset.createdAt.getTime() > Date.now() - 3600000
      )
        throw new AppError('Upload is still in progress', 409);
      await tx.catalogueImageAsset.update({
        where: { id },
        data: { state: 'DELETING' },
      });
    });
    await this.cleanup([id]);
    return { id };
  },
  async cleanup(ids?: string[]) {
    const assets = await prisma.catalogueImageAsset.findMany({
      where: {
        ...(ids ? { id: { in: ids } } : {}),
        images: { none: {} },
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
      orderBy: { createdAt: 'asc' },
    });
    for (const asset of assets) {
      const claimed = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM catalogue_image_assets WHERE id=${asset.id} FOR UPDATE`;
        return tx.catalogueImageAsset.updateMany({
          where: {
            id: asset.id,
            images: { none: {} },
            state: asset.state,
            updatedAt: asset.updatedAt,
          },
          data: { state: 'DELETING' },
        });
      });
      if (!claimed.count) continue;
      await bunnyStorage.request(asset.storageKey, 'DELETE');
      await prisma.catalogueImageAsset.deleteMany({
        where: { id: asset.id, state: 'DELETING', images: { none: {} } },
      });
    }
    return { processed: assets.length };
  },
  async content(id: string, adminId?: string, sessionId?: string) {
    const checkAdmin = async () => {
      if (!adminId) return;
      const user = await prisma.user.findFirst({
        where: {
          id: adminId,
          status: 'ACTIVE',
          isEmailVerified: true,
          assignedRole: { some: { role: 'ADMIN' } },
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
        select: { id: true },
      });
      if (!user) throw new AppError('Image not found', 404);
    };
    await checkAdmin();
    const accessWhere = (): Prisma.CatalogueImageAssetWhereInput => ({
      id,
      state: 'ACTIVE',
      ...(adminId
        ? { OR: [{ ownerId: adminId }, { images: { some: {} } }] }
        : { images: { some: { machine: publicMachineWhere() } } }),
    });
    const asset = await prisma.catalogueImageAsset.findFirst({
      where: accessWhere(),
    });
    if (!asset) throw new AppError('Image not found', 404);
    const response = await bunnyStorage.request(asset.storageKey, 'GET');
    if (
      !response.body ||
      Number(response.headers.get('content-length') ?? asset.fileSize) >
        asset.fileSize
    )
      throw new AppError('Image content is unavailable', 502);
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
          throw new AppError('Image content changed', 502);
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
      throw new AppError('Image content changed', 502);
    await checkAdmin();
    if (!(await prisma.catalogueImageAsset.findFirst({ where: accessWhere() })))
      throw new AppError('Image not found', 404);
    return { buffer, fileType: asset.fileType };
  },
};
