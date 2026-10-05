import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { auditSchema } from './audit.validation.js';
import { auditController } from './audit.controller.js';
export const AuditRoutes = Router();
AuditRoutes.use(authenticate(['ADMIN']));
AuditRoutes.get('/', validate(auditSchema), auditController.list);
