import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { catalogueSupplierService as service } from './catalogue.supplier.service.js';
export const catalogueSupplierController = {
  categories: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Machine categories',
      await service.categories(),
    );
  }),
  list: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Your machinery',
      await service.list(res.locals.auth.id, res.locals.validated.query),
    );
  }),
  detail: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Your machine',
      await service.detail(res.locals.auth.id, res.locals.validated.params.id),
    );
  }),
  create: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Machine created',
      await service.create(res.locals.auth.id, res.locals.validated.body),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Machine saved',
      await service.update(
        res.locals.auth.id,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  remove: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Machine deleted',
      await service.remove(
        res.locals.auth.id,
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
};
