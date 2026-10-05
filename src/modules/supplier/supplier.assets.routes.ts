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
import { supplierAssetService as service } from './supplier.assets.service.js';
const params = validate(z.object({ params: z.object({ id: z.uuid() }) }));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
}).single('file');
export const SupplierAssetRoutes = Router();
SupplierAssetRoutes.get(
  '/suppliers/assets/:id/logo',
  params,
  catchAsync(async (_req, res) => {
    const file = await service.content(res.locals.validated.params.id);
    res
      .set({
        'Content-Type': file.fileType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(file.buffer);
  }),
);
SupplierAssetRoutes.use('/supplier/assets', authenticate());
SupplierAssetRoutes.get(
  '/supplier/assets/status',
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(res, 'Supplier storage', {
      configured: bunnyStorage.isConfigured(),
    }),
  ),
);
SupplierAssetRoutes.post(
  '/supplier/assets/:purpose',
  rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: (_req, res) => res.locals.auth.id,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  }),
  validate(
    z.object({ params: z.object({ purpose: z.enum(['LOGO', 'DOCUMENT']) }) }),
  ),
  (req, res, next) =>
    upload(req, res, (error) =>
      next(
        error
          ? new AppError('Upload one PDF, JPEG or PNG up to 10 MB', 422)
          : undefined,
      ),
    ),
  catchAsync(async (req, res) => {
    if (!req.file) throw new AppError('File required', 422);
    ResponseHandler.send(
      res,
      201,
      'File uploaded',
      await service.upload(
        res.locals.auth.id,
        res.locals.auth.sessionId,
        res.locals.validated.params.purpose,
        req.file,
      ),
    );
  }),
);
SupplierAssetRoutes.get(
  '/supplier/assets/:id/content',
  params,
  catchAsync(async (_req, res) => {
    const file = await service.content(
      res.locals.validated.params.id,
      res.locals.auth.id,
      res.locals.auth.sessionId,
    );
    res
      .set({
        'Content-Type': file.fileType,
        'Content-Disposition':
          file.fileType === 'application/pdf' ? 'attachment' : 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.buffer);
  }),
);
SupplierAssetRoutes.delete(
  '/supplier/assets/:id',
  params,
  catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'File removed',
      await service.remove(res.locals.validated.params.id, res.locals.auth.id),
    ),
  ),
);
