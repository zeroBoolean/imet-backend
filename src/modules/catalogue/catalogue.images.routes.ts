import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { AppError } from '../../middleware/errorHandler.js';
import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { bunnyStorage } from '../../services/bunnyStorage.js';
import {
  catalogueImageService as service,
  MAX_IMAGE_BYTES,
  checkSupplierUpload,
} from './catalogue.images.service.js';
const params = validate(z.object({ params: z.object({ id: z.uuid() }) }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1 },
}).single('file');
const limiter = rateLimit({
  windowMs: 60000,
  limit: 10,
  keyGenerator: (_req, res) => res.locals.auth.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many image uploads. Try again later.',
  },
});
export const CatalogueImageRoutes = Router();
CatalogueImageRoutes.get(
  '/catalogue/images/:id/content',
  params,
  catchAsync(async (_req, res) => {
    const image = await service.content(res.locals.validated.params.id);
    res
      .set({
        'Content-Type': image.fileType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(image.buffer);
  }),
);
CatalogueImageRoutes.use(
  '/admin/catalogue/image-uploads',
  authenticate(['ADMIN']),
);
CatalogueImageRoutes.get(
  '/admin/catalogue/image-uploads/status',
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(res, 'Catalogue image storage', {
      configured: bunnyStorage.isConfigured(),
      maxBytes: MAX_IMAGE_BYTES,
      checkSupplierUpload,
    }),
  ),
);
CatalogueImageRoutes.post(
  '/admin/catalogue/image-uploads',
  limiter,
  (req, res, next) =>
    upload(req, res, (error) =>
      next(
        error
          ? new AppError(
              'Upload one JPEG or PNG file up to 10 MB, using the file field',
              422,
            )
          : undefined,
      ),
    ),
  catchAsync(async (req, res) => {
    if (!req.file) throw new AppError('Image file required', 422);
    ResponseHandler.send(
      res,
      201,
      'Image uploaded',
      await service.upload(
        res.locals.auth.id,
        req.file,
        res.locals.auth.sessionId,
      ),
    );
  }),
);
CatalogueImageRoutes.get(
  '/admin/catalogue/image-uploads/:id/preview',
  params,
  catchAsync(async (_req, res) => {
    const image = await service.content(
      res.locals.validated.params.id,
      res.locals.auth.id,
      res.locals.auth.sessionId,
    );
    res
      .set({
        'Content-Type': image.fileType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(image.buffer);
  }),
);
CatalogueImageRoutes.delete(
  '/admin/catalogue/image-uploads/:id',
  params,
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Image removed',
      await service.remove(res.locals.validated.params.id, res.locals.auth.id),
    ),
  ),
);

// Reuse the same upload lifecycle for entitled owning suppliers.
CatalogueImageRoutes.use('/supplier/catalogue/image-uploads', authenticate());
CatalogueImageRoutes.get(
  '/supplier/catalogue/image-uploads/status',
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(res, 'Catalogue image storage', {
      configured: bunnyStorage.isConfigured(),
      maxBytes: MAX_IMAGE_BYTES,
    }),
  ),
);
CatalogueImageRoutes.post(
  '/supplier/catalogue/image-uploads',
  limiter,
  catchAsync(async (_req, res, next) => {
    await checkSupplierUpload(res.locals.auth.id, res.locals.auth.sessionId);
    next();
  }),
  (req, res, next) =>
    upload(req, res, (error) =>
      next(
        error
          ? new AppError('Upload one JPEG or PNG up to 10 MB', 422)
          : undefined,
      ),
    ),
  catchAsync(async (req, res) => {
    if (!req.file) throw new AppError('Image file required', 422);
    ResponseHandler.send(
      res,
      201,
      'Image uploaded',
      await service.upload(
        res.locals.auth.id,
        req.file,
        res.locals.auth.sessionId,
        true,
      ),
    );
  }),
);
CatalogueImageRoutes.get(
  '/supplier/catalogue/image-uploads/:id/preview',
  params,
  catchAsync(async (_req, res) => {
    const file = await service.content(
      res.locals.validated.params.id,
      res.locals.auth.id,
      res.locals.auth.sessionId,
      true,
    );
    res
      .set({
        'Content-Type': file.fileType,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.buffer);
  }),
);
CatalogueImageRoutes.delete(
  '/supplier/catalogue/image-uploads/:id',
  params,
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Image removed',
      await service.remove(res.locals.validated.params.id, res.locals.auth.id),
    ),
  ),
);
