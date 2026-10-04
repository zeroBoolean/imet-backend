import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { salesService as service } from './sales.service.js';
export const salesController = {
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Sales pipeline',
      await service.list(res.locals.auth, res.locals.validated.query),
    );
  }),
  adminList: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'All sales opportunities',
      await service.list(res.locals.auth, res.locals.validated.query, true),
    );
  }),
  detail: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Sales opportunity',
      await service.detail(res.locals.auth, res.locals.validated.params.id),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Opportunity updated',
      await service.update(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  record: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Sale recorded',
      await service.record(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  records: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Sale history',
      await service.records(res.locals.auth, res.locals.validated.query),
    );
  }),
  adminRecords: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'All sale records',
      await service.records(res.locals.auth, res.locals.validated.query, true),
    );
  }),
  sale: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Sale record',
      await service.sale(res.locals.auth, res.locals.validated.params.id),
    );
  }),
  saleUpdate: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Sale status updated',
      await service.saleUpdate(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
};
