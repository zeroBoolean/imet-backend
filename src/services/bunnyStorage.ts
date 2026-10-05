import { config } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';
export const bunnyStorage = {
  isConfigured: () =>
    Boolean(config.BUNNY_STORAGE_ACCESS_KEY && config.BUNNY_STORAGE_ZONE),
  async request(key: string, method: 'PUT' | 'GET' | 'DELETE', body?: Buffer) {
    if (!this.isConfigured())
      throw new AppError('Bunny file storage is not configured', 503);
    if (
      !/^(?:catalogue\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:png|jpg)|rfq\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:pdf|png|jpg)|machinery\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:glb|png|jpg))$/.test(
        key,
      )
    )
      throw new AppError('Invalid storage reference', 500);
    let response: Response;
    try {
      response = await fetch(
        `https://${config.BUNNY_STORAGE_HOST}/${config.BUNNY_STORAGE_ZONE}/${key}`,
        {
          method,
          headers: {
            AccessKey: config.BUNNY_STORAGE_ACCESS_KEY!,
            'Content-Type': 'application/octet-stream',
          },
          ...(body ? { body: new Uint8Array(body) } : {}),
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        },
      );
    } catch {
      throw new AppError('File storage is temporarily unavailable', 502);
    }
    if (!response.ok && !(method === 'DELETE' && response.status === 404))
      throw new AppError('File storage is temporarily unavailable', 502);
    return response;
  },
};
