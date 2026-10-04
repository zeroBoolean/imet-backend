import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { AppError } from '../../middleware/errorHandler.js';
import { rfqSchemas } from './rfq.validation.js';
import { rfqAttachmentService as service } from './rfqAttachment.service.js';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
}).single('file');
export const RfqAttachmentRoutes = Router();
for (const quote of [false, true]) {
  const base = quote ? 'quotes' : 'rfqs';
  RfqAttachmentRoutes.post(
    `/${base}/:id/attachments`,
    authenticate(),
    validate(rfqSchemas.id),
    (req, res, next) =>
      upload(req, res, (error) =>
        next(
          error
            ? new AppError(
                'Upload one PDF, PNG or JPEG file no larger than 10 MB',
                422,
              )
            : undefined,
        ),
      ),
    catchAsync(async (req, res) => {
      if (!req.file) throw new AppError('File required', 422);
      ResponseHandler.send(
        res,
        201,
        'Attachment added',
        await service.upload(
          res.locals.auth,
          res.locals.validated.params.id,
          req.file,
          quote,
        ),
      );
    }),
  );
  RfqAttachmentRoutes.get(
    `/${quote ? 'quote-attachments' : 'rfq-attachments'}/:id`,
    authenticate(),
    validate(rfqSchemas.id),
    catchAsync(async (_req, res) => {
      const file = await service.download(
        res.locals.auth,
        res.locals.validated.params.id,
        quote,
      );
      res.set({
        'Content-Type': file.fileType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(file.buffer);
    }),
  );
}
