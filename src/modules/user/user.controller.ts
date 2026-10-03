import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { userService } from './user.service.js';
export const userController = {
  profile: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Profile updated',
      await userService.profile(
        res.locals.auth.id,
        res.locals.validated.body.displayName,
      ),
    );
  }),
  list: catchAsync(async (_req, res) => {
    const { page, limit } = res.locals.validated.query;
    ResponseHandler.ok(res, 'Users', await userService.list(page, limit));
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'User updated',
      await userService.update(
        res.locals.auth.id,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
};
