import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { reviewSchemas as s } from './review.validation.js';
import { reviewController as c } from './review.controller.js';
export const ReviewRoutes = Router();
ReviewRoutes.get('/public', validate(s.publicList), c.publicList);
ReviewRoutes.get('/highlights', validate(s.highlights), c.highlights);
ReviewRoutes.use(authenticate(['BUYER']));
ReviewRoutes.get('/', validate(s.list), c.list);
ReviewRoutes.get(
  '/eligibility/:saleId',
  validate(s.eligibility),
  c.eligibility,
);
ReviewRoutes.post('/', validate(s.create), c.create);
ReviewRoutes.patch('/:id', validate(s.update), c.update);
ReviewRoutes.post('/:id/withdraw', validate(s.withdraw), c.withdraw);
export const ReviewAdminRoutes = Router();
ReviewAdminRoutes.use(authenticate(['ADMIN']));
ReviewAdminRoutes.get('/', validate(s.list), c.adminList);
ReviewAdminRoutes.patch('/:id', validate(s.moderate), c.moderate);
