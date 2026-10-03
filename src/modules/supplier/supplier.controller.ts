import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { supplierService as service } from './supplier.service.js';
export const supplierController = {
  own: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Supplier profile',
      await service.own(res.locals.auth.id),
    );
  }),
  apply: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Application submitted',
      await service.apply(res.locals.auth.id, res.locals.validated.body),
    );
  }),
  updateOwn: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Profile saved',
      await service.updateOwn(res.locals.auth.id, res.locals.validated.body),
    );
  }),
  adminList: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Suppliers',
      await service.adminList(res.locals.validated.query),
    );
  }),
  adminDetail: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Supplier',
      await service.adminDetail(res.locals.validated.params.id),
    );
  }),
  review: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Supplier reviewed',
      await service.review(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  adminUpdate: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Supplier saved',
      await service.adminUpdate(
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  publicList: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Marketplace suppliers',
      await service.publicList(res.locals.validated.query),
    );
  }),
  publicDetail: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      200,
      'Marketplace supplier',
      await service.publicDetail(res.locals.validated.params.id),
    );
  }),
};
