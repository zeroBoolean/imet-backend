import { Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { AppError } from '../../middleware/errorHandler.js';
import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { z } from 'zod';
import { mediaInput, mediaParams } from './media.validation.js';
import { mediaService } from './media.service.js';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 2, fieldSize: 1024 },
}).single('file');
const limiter = rateLimit({
  windowMs: 60000,
  limit: 10,
  keyGenerator: (_req, res) => res.locals.auth.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many media uploads. Try again later.',
  },
});
export const MediaRoutes = Router();
const id = validate(z.object({ params: mediaParams }));
const roles = [
  'ADMIN',
  'LOCAL_SUPPLIER',
  'INTERNATIONAL_MANUFACTURER',
  'INDEPENDENT_SELLER',
] as const;
MediaRoutes.get(
  '/catalogue/media/:id/content',
  id,
  catchAsync(async (_req, res) => {
    const file = await mediaService.content(res.locals.validated.params.id);
    res
      .set({
        'Content-Type': file.fileType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
      .send(file.buffer);
  }),
);
MediaRoutes.get(
  '/catalogue/media/:id/preview',
  authenticate([...roles]),
  id,
  catchAsync(async (_req, res) => {
    const file = await mediaService.content(
      res.locals.validated.params.id,
      res.locals.auth,
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
MediaRoutes.get(
  '/catalogue/machines/:id/media',
  authenticate([...roles]),
  id,
  catchAsync(async (_req, res) =>
    ResponseHandler.send(
      res,
      200,
      'Machinery media',
      await mediaService.list(res.locals.auth, res.locals.validated.params.id),
    ),
  ),
);
MediaRoutes.post(
  '/catalogue/machines/:id/media',
  authenticate([...roles]),
  id,
  limiter,
  catchAsync(async (_req, res, next) => {
    await mediaService.authorize(
      res.locals.auth,
      res.locals.validated.params.id,
    );
    next();
  }),
  (req, res, next) =>
    upload(req, res, (error) =>
      next(
        error
          ? new AppError(
              'Upload one GLB up to 25 MB or panorama up to 10 MB with type and title',
              422,
            )
          : undefined,
      ),
    ),
  validate(z.object({ body: mediaInput, params: mediaParams })),
  catchAsync(async (req, res) => {
    if (!req.file) throw new AppError('File required', 422);
    ResponseHandler.send(
      res,
      201,
      'Machinery media added',
      await mediaService.upload(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
        req.file,
      ),
    );
  }),
);
MediaRoutes.delete(
  '/catalogue/media/:id',
  authenticate([...roles]),
  id,
  catchAsync(async (_req, res) =>
    ResponseHandler.send(
      res,
      200,
      'Machinery media removed',
      await mediaService.remove(
        res.locals.auth,
        res.locals.validated.params.id,
      ),
    ),
  ),
);
