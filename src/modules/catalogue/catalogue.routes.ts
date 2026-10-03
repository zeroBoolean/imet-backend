import { Router } from 'express';
import { validate } from '../../middleware/validation.js';
import { catalogueController } from './catalogue.controller.js';
import { detailSchema, listSchema } from './catalogue.validation.js';
const router = Router();
router.get('/categories', catalogueController.categories);
router.get('/machines', validate(listSchema), catalogueController.list);
router.get(
  '/machines/:slug',
  validate(detailSchema),
  catalogueController.detail,
);
export const CatalogueRoutes = router;
