import { rfqOptionsService } from './rfqOptions.service.js';
import { z } from 'zod';
import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { rfqController as c } from './rfq.controller.js';
import { rfqSchemas as s } from './rfq.validation.js';
export const RfqRoutes = Router();
RfqRoutes.use(authenticate());
RfqRoutes.post('/', authenticate(['BUYER']), validate(s.create), c.create);
RfqRoutes.get('/', authenticate(['BUYER']), validate(s.list), c.list);
RfqRoutes.get('/:id', validate(s.id), c.detail);
RfqRoutes.patch('/:id', authenticate(['BUYER']), validate(s.update), c.update);
RfqRoutes.post(
  '/:id/submit',
  authenticate(['BUYER']),
  validate(s.action),
  c.submit,
);
RfqRoutes.post('/:id/cancel', validate(s.action), c.cancel);
RfqRoutes.post('/:id/close', validate(s.action), c.close);
RfqRoutes.get('/:id/quotes', validate(s.id), c.rfqQuotes);
RfqRoutes.post('/:id/quotes', validate(s.quote), c.createQuote);
RfqRoutes.get('/:id/messages', validate(s.thread), c.messages);
RfqRoutes.post('/:id/messages', validate(s.message), c.message);
RfqRoutes.post(
  '/:id/recipients',
  authenticate(['SALES_PERSON', 'ADMIN']),
  validate(s.recipients),
  c.route,
);
export const QuoteRoutes = Router();
QuoteRoutes.use(authenticate());
QuoteRoutes.get('/', validate(s.quoteList), c.quotes);
QuoteRoutes.patch('/:id', validate(s.quoteUpdate), c.updateQuote);
QuoteRoutes.post('/:id/withdraw', validate(s.action), c.withdraw);
QuoteRoutes.post(
  '/:id/accept',
  authenticate(['BUYER']),
  validate(s.action),
  c.accept,
);
QuoteRoutes.post(
  '/:id/reject',
  authenticate(['BUYER']),
  validate(s.action),
  c.reject,
);
export const LeadRoutes = Router();
LeadRoutes.use(
  authenticate([
    'LOCAL_SUPPLIER',
    'INTERNATIONAL_MANUFACTURER',
    'INDEPENDENT_SELLER',
    'SALES_PERSON',
  ]),
);
LeadRoutes.get('/', validate(s.list), c.leads);
LeadRoutes.get('/:id', validate(s.id), c.lead);
LeadRoutes.post('/:id/viewed', validate(s.id), c.viewed);
LeadRoutes.post('/:id/decline', validate(s.id), c.decline);
export const RfqAdminRoutes = Router();
RfqAdminRoutes.use(authenticate(['ADMIN']));
RfqAdminRoutes.post('/:id/resend-notifications', validate(s.action), c.resend);
RfqAdminRoutes.get('/', validate(s.list), c.adminList);
RfqAdminRoutes.get('/:id', validate(s.id), c.detail);
RfqAdminRoutes.post('/:id/reroute', validate(s.action), c.route);
RfqAdminRoutes.post('/:id/recipients', validate(s.recipients), c.route);
RfqAdminRoutes.post('/:id/close', validate(s.action), c.close);
RfqAdminRoutes.post('/:id/cancel', validate(s.action), c.cancel);
RfqAdminRoutes.post('/:id/flag', validate(s.flag), c.flag);
export const LeadAdminRoutes = Router();
LeadAdminRoutes.use(authenticate(['ADMIN']));
LeadAdminRoutes.get('/', validate(s.overview), c.overview);

export const RfqOptionRoutes = Router();
RfqOptionRoutes.get(
  '/categories',
  authenticate(),
  catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'RFQ categories',
      await rfqOptionsService.categories(),
    );
  }),
);

RfqOptionRoutes.get(
  '/recipients',
  authenticate(['ADMIN', 'SALES_PERSON']),
  validate(
    z.object({
      query: z
        .object({
          q: z.string().trim().max(100).default(''),
          kind: z.enum(['recipient', 'buyer']).default('recipient'),
        })
        .strict(),
    }),
  ),
  catchAsync(async (_req, res) => {
    const q = res.locals.validated.query;
    ResponseHandler.ok(
      res,
      'Routing candidates',
      await rfqOptionsService.recipients(
        res.locals.auth,
        q.q,
        q.kind === 'buyer',
      ),
    );
  }),
);
