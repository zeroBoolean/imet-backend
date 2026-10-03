import type { Response } from 'express';
import type { ApiResponse } from '../types/shared.js';
export default class ResponseHandler {
  static send<T>(res: Response, status: number, message: string, data?: T) {
    const body: ApiResponse<T> = {
      success: status < 400,
      message,
      timestamp: new Date().toISOString(),
    };
    if (data !== undefined) body.data = data;
    return res.status(status).json(body);
  }
  static ok<T>(res: Response, message: string, data?: T) {
    return this.send(res, 200, message, data);
  }
}
