import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { rfqService } from './rfq.service.js';
import { quoteService } from './quote.service.js';
import { leadService } from './lead.service.js';
import { rfqMessageService } from './rfqMessage.service.js';
export const rfqController = {
  rfqQuotes: catchAsync(async (_req, res) => {
    const detail = await rfqService.detail(
      res.locals.auth,
      res.locals.validated.params.id,
    );
    ResponseHandler.ok(
      res,
      'RFQ quotes',
      detail.recipients.flatMap((r) => r.quotes),
    );
  }),
  resend: catchAsync(async (_req, res) => {
    await rfqService.resend(
      res.locals.auth,
      res.locals.validated.params.id,
      res.locals.validated.body.updatedAt,
    );
    ResponseHandler.ok(res, 'Notifications queued for retry');
  }),
  create: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'RFQ draft created',
      await rfqService.create(res.locals.auth, res.locals.validated.body),
    );
  }),
  update: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Draft saved',
      await rfqService.update(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  list: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Your RFQs',
      await rfqService.list(res.locals.auth, res.locals.validated.query),
    );
  }),
  adminList: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'All RFQs',
      await rfqService.list(
        res.locals.auth,
        res.locals.validated.query,
        'admin',
      ),
    );
  }),
  leads: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Your leads',
      await rfqService.list(
        res.locals.auth,
        res.locals.validated.query,
        'leads',
      ),
    );
  }),
  detail: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'RFQ',
      await rfqService.detail(res.locals.auth, res.locals.validated.params.id),
    );
  }),
  lead: catchAsync(async (_req, res) => {
    const id = await leadService.rfqId(
      res.locals.auth,
      res.locals.validated.params.id,
    );
    ResponseHandler.ok(
      res,
      'Lead',
      await rfqService.detail(res.locals.auth, id),
    );
  }),
  submit: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'RFQ submitted',
      await rfqService.submit(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  cancel: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'RFQ cancelled',
      await rfqService.end(
        res.locals.auth,
        res.locals.validated.params.id,
        'CANCELLED',
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  close: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'RFQ closed',
      await rfqService.end(
        res.locals.auth,
        res.locals.validated.params.id,
        'CLOSED',
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  route: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Routing updated',
      await rfqService.route(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body.updatedAt,
        res.locals.validated.body.userIds,
        res.locals.validated.body.action === 'REMOVE',
      ),
    );
  }),
  flag: catchAsync(async (_req, res) => {
    await rfqService.flag(
      res.locals.auth,
      res.locals.validated.params.id,
      res.locals.validated.body,
    );
    ResponseHandler.ok(res, 'Moderation saved');
  }),
  viewed: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Lead viewed',
      await leadService.action(res.locals.auth, res.locals.validated.params.id),
    );
  }),
  decline: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Lead declined',
      await leadService.action(
        res.locals.auth,
        res.locals.validated.params.id,
        true,
      ),
    );
  }),
  createQuote: catchAsync(async (_req, res) => {
    ResponseHandler.send(
      res,
      201,
      'Quote sent',
      await quoteService.create(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  updateQuote: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Quote updated',
      await quoteService.edit(
        res.locals.auth,
        res.locals.validated.params.id,
        res.locals.validated.body,
      ),
    );
  }),
  quotes: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Your quotes',
      await quoteService.list(res.locals.auth, res.locals.validated.query),
    );
  }),
  accept: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Quote accepted',
      await quoteService.action(
        res.locals.auth,
        res.locals.validated.params.id,
        'ACCEPTED',
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  reject: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Quote rejected',
      await quoteService.action(
        res.locals.auth,
        res.locals.validated.params.id,
        'REJECTED',
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  withdraw: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Quote withdrawn',
      await quoteService.action(
        res.locals.auth,
        res.locals.validated.params.id,
        'WITHDRAWN',
        res.locals.validated.body.updatedAt,
      ),
    );
  }),
  messages: catchAsync(async (_req, res) => {
    const q = res.locals.validated.query;
    ResponseHandler.ok(
      res,
      'Messages',
      await rfqMessageService.list(
        res.locals.auth,
        res.locals.validated.params.id,
        q.recipientId,
        q.before,
      ),
    );
  }),
  message: catchAsync(async (_req, res) => {
    const b = res.locals.validated.body;
    ResponseHandler.send(
      res,
      201,
      'Message sent',
      await rfqMessageService.send(
        res.locals.auth,
        res.locals.validated.params.id,
        b.recipientId,
        b.body,
      ),
    );
  }),
  overview: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Lead overview',
      await leadService.overview(res.locals.validated.query),
    );
  }),
};
