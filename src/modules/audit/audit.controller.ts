import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { auditService } from './audit.service.js';
export const auditController = {
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Admin audit',
      await auditService.list(res.locals.validated.query),
    );
  }),
};
