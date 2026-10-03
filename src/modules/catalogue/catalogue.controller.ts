import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { catalogueService } from './catalogue.service.js';
export const catalogueController = {
  categories: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Machine categories',
      await catalogueService.categories(),
    );
  }),
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Machine catalogue',
      await catalogueService.list(res.locals.validated.query),
    );
  }),
  detail: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Machine details',
      await catalogueService.detail(res.locals.validated.params.slug),
    );
  }),
};
