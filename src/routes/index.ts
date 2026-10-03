import {
  SupplierRoutes,
  SupplierAdminRoutes,
  SupplierPublicRoutes,
} from '../modules/supplier/supplier.routes.js';
import { SubscriptionAdminRoutes } from '../modules/subscription/subscription.routes.js';
import { CatalogueSupplierRoutes } from '../modules/catalogue/catalogue.supplier.routes.js';
import { CatalogueAdminRoutes } from '../modules/catalogue/catalogue.admin.routes.js';
import { CatalogueRoutes } from '../modules/catalogue/catalogue.routes.js';
import { UserRoutes } from '../modules/user/user.routes.js';
import { AuthRoutes } from '../modules/auth/auth.routes.js';
import { Router } from 'express';
import { HealthRoutes } from '../modules/health/health.routes.js';
const router = Router();
router.use('/supplier/catalogue', CatalogueSupplierRoutes);
router.use('/supplier', SupplierRoutes);
router.use('/suppliers', SupplierPublicRoutes);
router.use('/admin/suppliers', SupplierAdminRoutes);
router.use('/admin/subscriptions', SubscriptionAdminRoutes);
router.use('/admin/catalogue', CatalogueAdminRoutes);
router.use('/catalogue', CatalogueRoutes);
router.use('/auth', AuthRoutes);
router.use('/user', UserRoutes);
router.use('/health', HealthRoutes);
export default router;
