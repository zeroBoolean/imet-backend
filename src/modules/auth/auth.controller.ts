import catchAsync from '../../utils/asyncHandler.js';
import ResponseHandler from '../../utils/response.js';
import { authService } from './auth.service.js';
const genericEmailMessage =
  'If this address is eligible, you will receive an email shortly.';
export const authController = {
  register: catchAsync(async (_req, res) => {
    await authService.register(res.locals.validated.body);
    ResponseHandler.ok(res, genericEmailMessage);
  }),
  verify: catchAsync(async (_req, res) => {
    await authService.verify(res.locals.validated.body.token);
    ResponseHandler.ok(res, 'Email verified. You can now sign in.');
  }),
  login: catchAsync(async (_req, res) => {
    const body = res.locals.validated.body;
    ResponseHandler.ok(
      res,
      'Signed in',
      await authService.login(body.email, body.password),
    );
  }),
  me: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Current user',
      await authService.me(res.locals.auth.id),
    );
  }),
  resend: catchAsync(async (_req, res) => {
    await authService.resend(res.locals.validated.body.email);
    ResponseHandler.ok(res, genericEmailMessage);
  }),
  forgot: catchAsync(async (_req, res) => {
    await authService.forgot(res.locals.validated.body.email);
    ResponseHandler.ok(res, genericEmailMessage);
  }),
  reset: catchAsync(async (_req, res) => {
    const body = res.locals.validated.body;
    await authService.reset(body.token, body.password);
    ResponseHandler.ok(res, 'Password reset. Sign in with your new password.');
  }),
  change: catchAsync(async (_req, res) => {
    const body = res.locals.validated.body;
    await authService.changePassword(
      res.locals.auth.id,
      body.currentPassword,
      body.password,
    );
    ResponseHandler.ok(res, 'Password changed. Sign in again.');
  }),
  refresh: catchAsync(async (_req, res) => {
    ResponseHandler.ok(
      res,
      'Session refreshed',
      await authService.refresh(res.locals.validated.body.refreshToken),
    );
  }),
  logout: catchAsync(async (_req, res) => {
    await authService.logout(res.locals.auth.id, res.locals.auth.sessionId);
    ResponseHandler.ok(res, 'Signed out');
  }),
  logoutAll: catchAsync(async (_req, res) => {
    await authService.logout(
      res.locals.auth.id,
      res.locals.auth.sessionId,
      true,
    );
    ResponseHandler.ok(res, 'Signed out of all devices');
  }),
};
