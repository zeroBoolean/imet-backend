import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { translationSchemas as s } from './translation.validation.js';
import { translationController as c } from './translation.controller.js';
export const TranslationRoutes = Router();
// Read-only: this public endpoint never invokes a provider or consumes paid quota.
TranslationRoutes.post('/read', validate(s.read), c.read);
export const TranslationAdminRoutes = Router();
TranslationAdminRoutes.use(authenticate(['ADMIN']));
TranslationAdminRoutes.get('/resources', validate(s.list), c.resources);
TranslationAdminRoutes.get(
  '/resources/:type/:id',
  validate(s.detail),
  c.detail,
);
TranslationAdminRoutes.post(
  '/generate',
  rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (_req, res) => res.locals.auth.id,
    handler: (_req, res) =>
      res
        .status(429)
        .json({
          success: false,
          message: 'Too many translation requests. Try again later.',
          timestamp: new Date().toISOString(),
        }),
  }),
  validate(s.generate),
  c.generate,
);
