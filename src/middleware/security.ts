import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/env.js';
export const securityMiddlewares = [
  helmet(),
  cors({ origin: config.FRONTEND_URL }),
];
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) =>
    res
      .status(429)
      .json({
        success: false,
        message: 'Too many requests. Try again later.',
        timestamp: new Date().toISOString(),
      }),
});
