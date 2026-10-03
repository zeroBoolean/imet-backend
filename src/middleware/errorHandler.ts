import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
  ) {
    super(message);
  }
}
export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _req,
  res,
  _next,
) => {
  const timestamp = new Date().toISOString();
  if (error instanceof ZodError) {
    res
      .status(422)
      .json({
        success: false,
        message: 'Validation failed',
        errors: error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
        timestamp,
      });
    return;
  }
  if (
    error instanceof SyntaxError &&
    'status' in error &&
    error.status === 400
  ) {
    res
      .status(400)
      .json({ success: false, message: 'Invalid JSON body', timestamp });
    return;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    error.type === 'entity.too.large'
  ) {
    res
      .status(413)
      .json({
        success: false,
        message: 'Request body is too large',
        timestamp,
      });
    return;
  }
  const status = error instanceof AppError ? error.statusCode : 500;
  if (status >= 500) logger.error('Unhandled request error');
  res
    .status(status)
    .json({
      success: false,
      message:
        status < 500 && error instanceof AppError
          ? error.message
          : 'Internal server error',
      timestamp,
    });
};
export const notFoundHandler: RequestHandler = (_req, _res, next) =>
  next(new AppError('Resource not found', 404));
