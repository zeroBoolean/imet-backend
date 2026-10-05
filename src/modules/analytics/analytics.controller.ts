import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { analyticsService } from './analytics.service.js';
export const analyticsController = {
  overview: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Admin analytics',
      await analyticsService.overview(res.locals.validated.query),
    );
  }),
};
