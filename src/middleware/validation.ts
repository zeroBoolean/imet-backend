import type { RequestHandler } from 'express';
import type { z } from 'zod';
export const validate =
  (schema: z.ZodType): RequestHandler =>
  async (req, res, next) => {
    try {
      res.locals.validated = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
