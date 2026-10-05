import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { serviceTicketService as service } from './serviceTicket.service.js';
export const ticketController = {
  eligible: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Eligible purchases',
      await service.eligible(res.locals.auth, res.locals.validated.query),
    ),
  ),
  create: catchAsync(async (_req, res) =>
    ResponseHandler.send(
      res,
      201,
      'Service ticket submitted',
      await service.create(res.locals.auth, res.locals.validated.body),
    ),
  ),
  list: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Service tickets',
      await service.list(res.locals.auth, res.locals.validated.query),
    ),
  ),
  adminList: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Service management',
      await service.list(res.locals.auth, res.locals.validated.query, true),
    ),
  ),
  detail: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Service ticket',
      await service.detail(res.locals.auth, res.locals.validated.params.id),
    ),
  ),
  events: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Service history',
      await service.events(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.query,
      ),
    ),
  ),
  note: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Progress saved',
      await service.note(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    ),
  ),
  status: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Ticket updated',
      await service.status(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    ),
  ),
  assignees: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Eligible service parties',
      await service.assignees(res.locals.auth, res.locals.validated.params.id),
    ),
  ),
  assign: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Ticket assigned',
      await service.assign(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    ),
  ),
  warranty: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Warranty assessment saved',
      await service.warranty(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    ),
  ),
};
