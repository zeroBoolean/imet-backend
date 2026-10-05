import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { ticketController as c } from './serviceTicket.controller.js';
import { ticketSchemas as s } from './serviceTicket.validation.js';
import { serviceRoles } from './serviceTicket.service.js';
export const ServiceTicketRoutes = Router(),
  ServiceTicketAdminRoutes = Router();
ServiceTicketRoutes.use(authenticate(['BUYER', ...serviceRoles]));
const limiter = rateLimit({
  windowMs: 60000,
  limit: 10,
  keyGenerator: (_req, res) => res.locals.auth.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many service submissions. Try again later.',
  },
});
ServiceTicketRoutes.get(
  '/eligible-purchases',
  authenticate(['BUYER']),
  validate(s.eligible),
  c.eligible,
);
ServiceTicketRoutes.post(
  '/',
  authenticate(['BUYER']),
  limiter,
  validate(s.create),
  c.create,
);
ServiceTicketRoutes.get('/', validate(s.list), c.list);
ServiceTicketRoutes.get('/:id', validate(s.id), c.detail);
ServiceTicketRoutes.get('/:id/events', validate(s.events), c.events);
ServiceTicketRoutes.post('/:id/notes', validate(s.note), c.note);
ServiceTicketRoutes.patch('/:id/status', validate(s.status), c.status);
ServiceTicketAdminRoutes.use(authenticate(['ADMIN']));
ServiceTicketAdminRoutes.get('/', validate(s.list), c.adminList);
ServiceTicketAdminRoutes.get('/:id/assignees', validate(s.id), c.assignees);
ServiceTicketAdminRoutes.patch(
  '/:id/assignment',
  validate(s.assignment),
  c.assign,
);
ServiceTicketAdminRoutes.patch(
  '/:id/warranty',
  validate(s.warranty),
  c.warranty,
);
