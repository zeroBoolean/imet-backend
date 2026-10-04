import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { translationService as service } from './translation.service.js';
export const translationController = {
  read: catchAsync(async (_req, res) => {
    const { resources, targetLanguage } = res.locals.validated.body;
    ResponseHandler.ok(
      res,
      'Available public translations',
      await service.read(resources, targetLanguage),
    );
  }),
  resources: catchAsync(async (_req, res) =>
    ResponseHandler.ok(
      res,
      'Public content eligible for translation',
      await service.resources(res.locals.validated.query),
    ),
  ),
  detail: catchAsync(async (_req, res) => {
    const { type, id } = res.locals.validated.params;
    ResponseHandler.ok(
      res,
      'Translation fields and status',
      await service.detail(type, id),
    );
  }),
  generate: catchAsync(async (_req, res) => {
    const result = await service.generate(res.locals.validated.body);
    ResponseHandler.send(
      res,
      result.status === 'PROCESSING' ? 202 : 200,
      result.status === 'PROCESSING'
        ? 'Translation is processing; reload its status.'
        : 'Translation available',
      result,
    );
  }),
};
