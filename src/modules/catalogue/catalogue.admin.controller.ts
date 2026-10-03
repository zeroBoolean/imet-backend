import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { catalogueAdminService as service } from './catalogue.admin.service.js';
export const catalogueAdminController = {
  categories: catchAsync(async (_req, res) => {
    ResponseHandler.ok(res, 'Admin categories', await service.categories());
  }),
  categoryCreate: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Category created',
      await service.createCategory(res.locals.validated.body),
    );
  }),
  categoryUpdate: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Category updated',
      await service.updateCategory(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  categoryDelete: catchAsync(async (_req, res) => {
    await service.deleteCategory(res.locals.validated.params.id);
    ResponseHandler.ok(res, 'Category deleted');
  }),
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Admin catalogue',
      await service.list(res.locals.validated.query),
    );
  }),
  detail: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Admin machine',
      await service.detail(res.locals.validated.params.id),
    );
  }),
  create: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Machine created',
      await service.create(res.locals.validated.body),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Machine updated',
      await service.update(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  remove: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Machine deleted',
      await service.remove(
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
};
