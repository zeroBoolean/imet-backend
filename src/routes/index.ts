import { UserRoutes } from '../modules/user/user.routes.js';
import { AuthRoutes } from '../modules/auth/auth.routes.js';
import { Router } from 'express';
import { HealthRoutes } from '../modules/health/health.routes.js';
const router = Router();
router.use('/auth', AuthRoutes);
router.use('/user', UserRoutes);
router.use('/health', HealthRoutes);
export default router;
