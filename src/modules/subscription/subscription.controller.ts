import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { subscriptionService as service } from './subscription.service.js';
export const subscriptionController = {
  plans: catchAsync(async (_req, res) => {
    ResponseHandler.send(res, 200, 'Subscription plans', await service.plans());
  }),
  availablePlans: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Available plans',
      await service.availablePlans(res.locals.auth.id),
    );
  }),
  createPlan: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Plan created',
      await service.createPlan(res.locals.validated.body),
    );
  }),
  updatePlan: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Plan saved',
      await service.updatePlan(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  assign: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Subscription assigned',
      await service.assign(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Subscription saved',
      await service.update(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
};
