import { checkDatabase } from '../../config/database.js';
export const healthService = {
  async check() {
    try {
      await checkDatabase();
      return { status: 'ready', database: 'connected' } as const;
    } catch {
      return { status: 'unavailable', database: 'disconnected' } as const;
    }
  },
};
