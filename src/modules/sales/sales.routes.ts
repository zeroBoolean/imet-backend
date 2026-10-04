import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { salesSchemas as s } from './sales.validation.js';
import { salesController as c } from './sales.controller.js';
import type { UserRole } from '../../generated/client.js';
const sellers: UserRole[] = [
  'LOCAL_SUPPLIER',
  'INTERNATIONAL_MANUFACTURER',
  'INDEPENDENT_SELLER',
  'SALES_PERSON',
  'ADMIN',
];
export const SalesRoutes = Router();
SalesRoutes.use(authenticate());
SalesRoutes.get(
  '/opportunities',
  authenticate(sellers),
  validate(s.list),
  c.list,
);
SalesRoutes.get(
  '/opportunities/:id',
  authenticate(sellers),
  validate(s.id),
  c.detail,
);
SalesRoutes.patch(
  '/opportunities/:id',
  authenticate(sellers),
  validate(s.update),
  c.update,
);
SalesRoutes.post(
  '/opportunities/:id/record-sale',
  authenticate(sellers),
  validate(s.record),
  c.record,
);
SalesRoutes.get(
  '/records',
  authenticate([...sellers, 'BUYER']),
  validate(s.list),
  c.records,
);
SalesRoutes.get(
  '/records/:id',
  authenticate([...sellers, 'BUYER']),
  validate(s.id),
  c.sale,
);
SalesRoutes.patch(
  '/records/:id',
  authenticate(sellers),
  validate(s.saleUpdate),
  c.saleUpdate,
);
export const SalesAdminRoutes = Router();
SalesAdminRoutes.use(authenticate(['ADMIN']));
SalesAdminRoutes.get('/opportunities', validate(s.list), c.adminList);
SalesAdminRoutes.get('/opportunities/:id', validate(s.id), c.detail);
SalesAdminRoutes.get('/records', validate(s.list), c.adminRecords);
SalesAdminRoutes.get('/records/:id', validate(s.id), c.sale);
