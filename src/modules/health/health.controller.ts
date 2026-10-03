import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { healthService } from './health.service.js';
export const healthController = {
  check: catchAsync(async (_req, res) => {
    const data = await healthService.check();
    ResponseHandler.send(
      res,
      data.status === 'ready' ? 200 : 503,
      data.status === 'ready'
        ? 'Services are ready'
        : 'Database is unavailable',
      data,
    );
  }),
};
