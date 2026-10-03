import { Router } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { validate } from '../../middleware/validation.js';
import { authenticate } from '../../middleware/auth.js';
import { authController as c } from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  emailSchema,
  tokenSchema,
  refreshSchema,
  resetSchema,
  changeSchema,
} from './auth.validation.js';
const limiter = (limit: number, includeClient = true) =>
  rateLimit({
    windowMs: 15 * 60_000,
    keyGenerator: (req) =>
      `${includeClient ? ipKeyGenerator(req.ip || '127.0.0.1') : 'recipient'}:${createHash(
        'sha256',
      )
        .update(
          String(req.body?.email || req.path)
            .trim()
            .toLowerCase(),
        )
        .digest('hex')}`,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        message: 'Too many attempts. Try again later.',
        timestamp: new Date().toISOString(),
      }),
  });
const loginLimiter = limiter(20),
  emailLimiter = limiter(10, false);
export const AuthRoutes = Router();
AuthRoutes.post(
  '/register',
  emailLimiter,
  validate(registerSchema),
  c.register,
);
AuthRoutes.post('/login', loginLimiter, validate(loginSchema), c.login);
AuthRoutes.post('/verify-user', loginLimiter, validate(tokenSchema), c.verify);
AuthRoutes.post(
  '/resend-verification',
  emailLimiter,
  validate(emailSchema),
  c.resend,
);
AuthRoutes.post(
  '/forgot-password',
  emailLimiter,
  validate(emailSchema),
  c.forgot,
);
AuthRoutes.post(
  '/reset-password',
  loginLimiter,
  validate(resetSchema),
  c.reset,
);
AuthRoutes.post('/refresh', validate(refreshSchema), c.refresh);
AuthRoutes.get('/me', authenticate(), c.me);
AuthRoutes.post(
  '/change-password',
  authenticate(),
  loginLimiter,
  validate(changeSchema),
  c.change,
);
AuthRoutes.post('/logout', authenticate(), c.logout);
AuthRoutes.post('/logout-all', authenticate(), c.logoutAll);
