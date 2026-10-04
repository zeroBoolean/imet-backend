import { randomUUID } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { prisma } from '../../config/database.js';
import { bunnyStorage } from '../../services/bunnyStorage.js';
import { AppError } from '../../middleware/errorHandler.js';
import { rfqAccess, lockRfq, type Actor } from './rfq.access.js';
import { rfqEvent } from './rfqEvent.service.js';
export async function validateAttachment(buffer: Buffer) {
  if (!buffer.length || buffer.length > 10 * 1024 * 1024)
    throw new AppError('Attachments must be between 1 byte and 10 MB', 422);
  const type = await fileTypeFromBuffer(buffer).catch(() => undefined);
  if (
    !type ||
    !['application/pdf', 'image/png', 'image/jpeg'].includes(type.mime)
  )
    throw new AppError(
      'Only PDF, JPEG and PNG files are allowed. File content must match its type',
      422,
    );
  return type;
}
// Keep the RFQ-only key boundary: catalogue delivery never serves this namespace.
export const storageRequest = async (
  key: string,
  method: 'PUT' | 'GET' | 'DELETE',
  body?: Buffer,
) => {
  if (!/^rfq\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(key))
    throw new AppError('Invalid storage reference', 500);
  return bunnyStorage.request(key, method, body);
};
export const rfqAttachmentService = {
  async upload(a: Actor, id: string, file: Express.Multer.File, quote = false) {
    const type = await validateAttachment(file.buffer);
    const filename =
      file.originalname
        .split(/[\\/]/)
        .at(-1)!
        .split('')
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, 250) || `attachment.${type.ext}`;
    let rfqId = id;
    if (quote) {
      const q = await prisma.rfqQuote.findUnique({
        where: { id },
        include: { recipient: true },
      });
      if (!q || q.recipient.recipientId !== a.id || q.recipient.removedAt)
        throw new AppError('Quote not found', 404);
      rfqId = q.rfqId;
    }
    await prisma.$transaction(async (tx) => {
      const r = await rfqAccess(tx, rfqId, a);
      if (quote) {
        const q = await tx.rfqQuote.findUniqueOrThrow({ where: { id } });
        if (
          q.status !== 'PENDING' ||
          !['ROUTED', 'QUOTED'].includes(r.status) ||
          r.isFlagged
        )
          throw new AppError('Quote is not editable', 409);
      } else if (r.buyerId !== a.id || r.status !== 'DRAFT')
        throw new AppError('Only your draft RFQ accepts attachments', 409);
    });
    const key = `rfq/${rfqId}/${randomUUID()}.${type.ext}`;
    await storageRequest(key, 'PUT', file.buffer);
    try {
      return await prisma.$transaction(async (tx) => {
        const r = await lockRfq(tx, rfqId);
        if (r.isFlagged) throw new AppError('RFQ is flagged', 409);
        if (quote) {
          const q = await tx.rfqQuote.findUniqueOrThrow({
            where: { id },
            include: { recipient: true },
          });
          if (
            q.status !== 'PENDING' ||
            q.recipient.recipientId !== a.id ||
            q.recipient.removedAt ||
            !['ROUTED', 'QUOTED'].includes(r.status) ||
            (r.expiresAt && r.expiresAt <= new Date())
          )
            throw new AppError('Quote is not editable', 409);
          if (
            (await tx.rfqQuoteAttachment.count({ where: { quoteId: id } })) >=
            10
          )
            throw new AppError('At most 10 attachments are allowed', 422);
        } else {
          if (r.buyerId !== a.id || r.status !== 'DRAFT')
            throw new AppError('Only your draft RFQ accepts attachments', 409);
          if ((await tx.rfqAttachment.count({ where: { rfqId } })) >= 10)
            throw new AppError('At most 10 attachments are allowed', 422);
        }
        const data = {
          storageKey: key,
          fileName: filename,
          fileType: type.mime,
          fileSize: file.size,
          uploadedById: a.id,
        };
        const row = quote
          ? await tx.rfqQuoteAttachment.create({
              data: { ...data, quoteId: id },
            })
          : await tx.rfqAttachment.create({ data: { ...data, rfqId } });
        await rfqEvent(tx, rfqId, a.id, 'ATTACHMENT_ADDED', {
          attachmentId: row.id,
          quote,
        });
        const { storageKey, ...safe } = row;
        void storageKey;
        return safe;
      });
    } catch (error) {
      try {
        await storageRequest(key, 'DELETE');
      } catch {
        console.error('Orphaned attachment cleanup needed', {
          storageKey: key,
        });
      }
      throw error;
    }
  },
  async download(a: Actor, id: string, quote = false) {
    const file = quote
      ? await prisma.rfqQuoteAttachment.findUnique({
          where: { id },
          include: { quote: { include: { recipient: true } } },
        })
      : await prisma.rfqAttachment.findUnique({ where: { id } });
    if (!file) throw new AppError('Attachment not found', 404);
    const quoteFile = 'quote' in file ? file.quote : null;
    const rfqId = quoteFile
      ? quoteFile.rfqId
      : 'rfqId' in file
        ? file.rfqId
        : '';
    await prisma.$transaction(async (tx) => {
      const r = await rfqAccess(tx, rfqId, a);
      if (
        quoteFile &&
        !a.roles.includes('ADMIN') &&
        r.buyerId !== a.id &&
        quoteFile.recipient.recipientId !== a.id
      )
        throw new AppError('Attachment not found', 404);
    });
    const response = await storageRequest(file.storageKey, 'GET');
    if (
      Number(response.headers.get('content-length') ?? file.fileSize) >
      10 * 1024 * 1024
    )
      throw new AppError('Attachment size is invalid', 502);
    if (!response.body)
      throw new AppError('Attachment content is missing', 502);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 10 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError('Attachment size is invalid', 502);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks);
    const detected = await validateAttachment(buffer);
    if (detected.mime !== file.fileType)
      throw new AppError('Attachment content changed', 502);
    if (buffer.length !== file.fileSize)
      throw new AppError('Attachment content changed', 502);
    return { buffer, fileName: file.fileName, fileType: file.fileType };
  },
};
