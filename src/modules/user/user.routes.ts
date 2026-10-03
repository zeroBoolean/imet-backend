import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { userController as c } from './user.controller.js';
import { listSchema, updateSchema, profileSchema } from './user.validation.js';
export const UserRoutes = Router();
UserRoutes.patch('/me', authenticate(), validate(profileSchema), c.profile);
UserRoutes.get('/', authenticate(['ADMIN']), validate(listSchema), c.list);
UserRoutes.patch(
  '/:id',
  authenticate(['ADMIN']),
  validate(updateSchema),
  c.update,
);
