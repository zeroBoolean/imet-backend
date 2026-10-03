import { Router } from 'express';
import { HealthRoutes } from '../modules/health/health.routes.js';
const router = Router();
router.use('/health', HealthRoutes);
export default router;
