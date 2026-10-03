import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { supplierController as c } from './supplier.controller.js';
import { supplierSchemas as s } from './supplier.validation.js';
import { subscriptionController } from '../subscription/subscription.controller.js';
import { subscriptionSchemas } from '../subscription/subscription.validation.js';
export const SupplierRoutes = Router();
SupplierRoutes.use(authenticate());
SupplierRoutes.get('/me', c.own);
SupplierRoutes.post('/applications', validate(s.apply), c.apply);
SupplierRoutes.put('/me', validate(s.ownUpdate), c.updateOwn);
SupplierRoutes.get('/plans', subscriptionController.availablePlans);
export const SupplierAdminRoutes = Router();
SupplierAdminRoutes.use(authenticate(['ADMIN']));
SupplierAdminRoutes.get('/', validate(s.list), c.adminList);
SupplierAdminRoutes.get('/:id', validate(s.id), c.adminDetail);
SupplierAdminRoutes.put('/:id', validate(s.adminProfile), c.adminUpdate);
SupplierAdminRoutes.patch('/:id/review', validate(s.review), c.review);
SupplierAdminRoutes.post(
  '/:id/subscriptions',
  validate(subscriptionSchemas.assign),
  subscriptionController.assign,
);
export const SupplierPublicRoutes = Router();
SupplierPublicRoutes.get('/', validate(s.publicList), c.publicList);
SupplierPublicRoutes.get('/:id', validate(s.id), c.publicDetail);
