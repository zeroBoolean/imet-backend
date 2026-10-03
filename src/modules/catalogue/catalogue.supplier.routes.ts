import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { catalogueSupplierController as c } from './catalogue.supplier.controller.js';
import { adminSchemas, machineBody } from './catalogue.admin.validation.js';
import { z } from 'zod';
export const CatalogueSupplierRoutes = Router();
CatalogueSupplierRoutes.use(
  authenticate(['LOCAL_SUPPLIER', 'INTERNATIONAL_MANUFACTURER']),
);
CatalogueSupplierRoutes.get('/categories', c.categories);
CatalogueSupplierRoutes.get('/machines', validate(adminSchemas.list), c.list);
CatalogueSupplierRoutes.get(
  '/machines/:id',
  validate(adminSchemas.id),
  c.detail,
);
CatalogueSupplierRoutes.post(
  '/machines',
  validate(z.object({ body: machineBody })),
  c.create,
);
CatalogueSupplierRoutes.put(
  '/machines/:id',
  validate(
    z.object({
      params: z.object({ id: z.uuid() }),
      body: machineBody.extend({ updatedAt: z.iso.datetime() }),
    }),
  ),
  c.update,
);
CatalogueSupplierRoutes.delete(
  '/machines/:id',
  validate(adminSchemas.remove),
  c.remove,
);
