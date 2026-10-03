import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { catalogueAdminController as c } from './catalogue.admin.controller.js';
import { adminSchemas as s } from './catalogue.admin.validation.js';
export const CatalogueAdminRoutes = Router();
CatalogueAdminRoutes.use(authenticate(['ADMIN']));
CatalogueAdminRoutes.get('/categories', c.categories);
CatalogueAdminRoutes.post(
  '/categories',
  validate(s.categoryCreate),
  c.categoryCreate,
);
CatalogueAdminRoutes.put(
  '/categories/:id',
  validate(s.categoryUpdate),
  c.categoryUpdate,
);
CatalogueAdminRoutes.delete(
  '/categories/:id',
  validate(s.id),
  c.categoryDelete,
);
CatalogueAdminRoutes.get('/machines', validate(s.list), c.list);
CatalogueAdminRoutes.get('/machines/:id', validate(s.id), c.detail);
CatalogueAdminRoutes.post('/machines', validate(s.create), c.create);
CatalogueAdminRoutes.put('/machines/:id', validate(s.update), c.update);
CatalogueAdminRoutes.delete('/machines/:id', validate(s.remove), c.remove);
