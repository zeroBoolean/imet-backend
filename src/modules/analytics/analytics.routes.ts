import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { overviewSchema } from './analytics.validation.js';
import { analyticsController } from './analytics.controller.js';
export const AnalyticsRoutes = Router();
AnalyticsRoutes.use(authenticate(['ADMIN']));
AnalyticsRoutes.get(
  '/overview',
  validate(overviewSchema),
  analyticsController.overview,
);
