import { Router } from 'express';
import { healthController } from './health.controller.js';
export const HealthRoutes = Router();
HealthRoutes.get('/', healthController.check);
