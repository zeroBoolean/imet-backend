import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '../../config/database.js';
import type { Prisma } from '../../generated/client.js';
import { AppError } from '../../middleware/errorHandler.js';
import { bunnyStorage } from '../../services/bunnyStorage.js';
import {
  publicMachineWhere,
  requireEntitlement,
} from '../subscription/subscription.entitlements.js';
import type { Actor } from '../rfq/rfq.access.js';
import { validateMedia } from './media.validation.js';
export const mediaSelect = {
  id: true,
  type: true,
  title: true,
  fileType: true,
  fileSize: true,
  position: true,
  createdAt: true,
} satisfies Prisma.MachineMediaSelect;
async function manage(
  tx: Prisma.TransactionClient,
  machineId: string,
  actor: Actor,
) {
  const machine = await tx.machine.findUnique({
    where: { id: machineId },
    select: { supplierId: true, status: true },
  });
  if (!machine) throw new AppError('Machine not found', 404);
  if (!actor.roles.includes('ADMIN')) {
    if (!machine.supplierId) throw new AppError('Machine not found', 404);
    const own = await tx.supplier.findUnique({
      where: { id: machine.supplierId },
      select: { userId: true },
    });
    if (own?.userId !== actor.id) throw new AppError('Machine not found', 404);
    await requireEntitlement(tx, machine.supplierId, {
      userId: actor.id,
      publishing: machine.status === 'PUBLISHED',
    });
  }
  await tx.$queryRaw`SELECT id FROM machines WHERE id=${machineId} FOR UPDATE`;
  const locked = await tx.machine.findUnique({
    where: { id: machineId },
    select: { supplierId: true, status: true },
  });
  if (
    !locked ||
    locked.supplierId !== machine.supplierId ||
    locked.status !== machine.status
  )
    throw new AppError('Machine changed. Reload before managing media', 409);
  return machine;
}
export const mediaService = {
  async authorize(actor: Actor, machineId: string) {
    await prisma.$transaction((tx) => manage(tx, machineId, actor));
  },
  async list(actor: Actor, machineId: string) {
    return prisma.$transaction(async (tx) => {
      await manage(tx, machineId, actor);
      return {
        configured: bunnyStorage.isConfigured(),
        media: await tx.machineMedia.findMany({
          where: { machineId },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: { ...mediaSelect, state: true },
        }),
      };
    });
  },
  async upload(
    actor: Actor,
    machineId: string,
    input: { type: 'MODEL_3D' | 'VIEW_360'; title: string },
    file: Express.Multer.File,
  ) {
    const detected = await validateMedia(file.buffer, input.type);
    const key = `machinery/${machineId}/${randomUUID()}.${detected.ext}`;
    const reserved = await prisma.$transaction(async (tx) => {
      await manage(tx, machineId, actor);
      if ((await tx.machineMedia.count({ where: { machineId } })) >= 5)
        throw new AppError(
          'At most 5 advanced media assets are allowed per machine',
          422,
        );
      const position = await tx.machineMedia.aggregate({
        where: { machineId },
        _max: { position: true },
      });
      return tx.machineMedia.create({
        data: {
          machineId,
          ...input,
          state: 'UPLOADING',
          storageKey: key,
          fileType: detected.fileType,
          fileName:
            file.originalname
              .split(/[\\/]/)
              .at(-1)!
              .split('')
              .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
              .join('')
              .slice(0, 250) || `media.${detected.ext}`,
          fileSize: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          position: (position._max.position ?? -1) + 1,
        },
      });
    });
    try {
      await bunnyStorage.request(key, 'PUT', file.buffer);
      return await prisma.$transaction(async (tx) => {
        await manage(tx, machineId, actor);
        const changed = await tx.machineMedia.updateMany({
          where: { id: reserved.id, state: 'UPLOADING' },
          data: { state: 'ACTIVE' },
        });
        if (!changed.count)
          throw new AppError('Upload was interrupted. Reload media.', 409);
        return tx.machineMedia.findUniqueOrThrow({
          where: { id: reserved.id },
          select: mediaSelect,
        });
      });
    } catch (error) {
      // Durable reservation survives crashes and failed cleanup; all non-active states stay private.
      try {
        await prisma.machineMedia.updateMany({
          where: { id: reserved.id },
          data: { state: 'DELETING' },
        });
        await bunnyStorage.request(key, 'DELETE');
        await prisma.machineMedia.deleteMany({
          where: { id: reserved.id, state: 'DELETING' },
        });
      } catch {
        console.error('Catalogue upload cleanup pending', {
          mediaId: reserved.id,
        });
      }
      throw error;
    }
  },
  async remove(actor: Actor, id: string) {
    const file = await prisma.machineMedia.findUnique({ where: { id } });
    if (!file) throw new AppError('Media not found', 404);
    if (
      file.state === 'UPLOADING' &&
      file.createdAt.getTime() > Date.now() - 60000
    )
      throw new AppError(
        'Upload is still in progress. Retry removal after one minute.',
        409,
      );
    await prisma.$transaction(async (tx) => {
      await manage(tx, file.machineId, actor);
      await tx.machineMedia.update({
        where: { id },
        data: { state: 'DELETING' },
      });
    });
    // Persist the deleting state before storage I/O: failures remain retryable and never public.
    await bunnyStorage.request(file.storageKey, 'DELETE');
    await prisma.machineMedia.deleteMany({ where: { id, state: 'DELETING' } });
    return { id };
  },
  async content(id: string, actor?: Actor) {
    const file = await prisma.machineMedia.findFirst({
      where: { id, state: 'ACTIVE' },
    });
    if (!file) throw new AppError('Media not found', 404);
    if (actor)
      await prisma.$transaction((tx) => manage(tx, file.machineId, actor));
    else if (
      !(await prisma.machine.findFirst({
        where: { id: file.machineId, ...publicMachineWhere() },
        select: { id: true },
      }))
    )
      throw new AppError('Media not found', 404);
    const response = await bunnyStorage.request(file.storageKey, 'GET');
    if (
      !response.body ||
      Number(response.headers.get('content-length') ?? file.fileSize) >
        file.fileSize
    )
      throw new AppError('Media content is unavailable', 502);
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > file.fileSize) {
          await reader.cancel();
          throw new AppError('Media content changed', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    if (
      buffer.length !== file.fileSize ||
      createHash('sha256').update(buffer).digest('hex') !== file.sha256
    )
      throw new AppError('Media content changed', 502);
    // Recheck visibility after storage I/O, including subscription expiry and deletion races.
    if (
      !(await prisma.machineMedia.findFirst({
        where: {
          id,
          state: 'ACTIVE',
          ...(actor ? {} : { machine: publicMachineWhere() }),
        },
        select: { id: true },
      }))
    )
      throw new AppError('Media not found', 404);
    if (actor)
      await prisma.$transaction((tx) => manage(tx, file.machineId, actor));
    return { buffer, fileType: file.fileType };
  },
};
