import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
export const signAccessToken = (userId: string, sessionId: string) =>
  jwt.sign({ sid: sessionId, type: 'ACCESS' }, config.JWT_SECRET, {
    subject: userId,
    issuer: 'imet-server',
    audience: 'imet-client',
    algorithm: 'HS256',
    expiresIn: '15m',
  });
export const verifyAccessToken = (token: string) => {
  try {
    const result = jwt.verify(token, config.JWT_SECRET, {
      issuer: 'imet-server',
      audience: 'imet-client',
      algorithms: ['HS256'],
    });
    if (
      typeof result === 'string' ||
      result.type !== 'ACCESS' ||
      typeof result.sub !== 'string' ||
      typeof result.sid !== 'string'
    )
      throw new Error();
    return { userId: result.sub, sessionId: result.sid };
  } catch {
    throw new AppError('Invalid or expired session', 401);
  }
};
