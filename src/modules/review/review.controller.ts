import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { reviewService as service } from './review.service.js';
export const reviewController = {
  publicList: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Published reviews',
      await service.publicList(res.locals.validated.query),
    );
  }),
  highlights: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Recent published reviews',
      await service.highlights(res.locals.validated.query.limit),
    );
  }),
  eligibility: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Review eligibility',
      await service.eligibility(
        res.locals.auth,
        res.locals.validated.params.saleId,
      ),
    );
  }),
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Your reviews',
      await service.list(res.locals.auth, res.locals.validated.query),
    );
  }),
  adminList: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Review moderation',
      await service.list(res.locals.auth, res.locals.validated.query, true),
    );
  }),
  create: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Review submitted for approval',
      await service.create(res.locals.auth, res.locals.validated.body),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Review resubmitted for approval',
      await service.update(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  withdraw: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Review withdrawn',
      await service.withdraw(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  moderate: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Moderation saved',
      await service.moderate(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
};
