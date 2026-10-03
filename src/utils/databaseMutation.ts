import { AppError } from '../middleware/errorHandler.js';
export async function databaseMutation<T>(
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'P2002')
        throw new AppError('This record already exists', 409);
      if (error.code === 'P2003')
        throw new AppError('Referenced record is missing or still in use', 409);
      if (error.code === 'P2025') throw new AppError('Record not found', 404);
    }
    throw error;
  }
}
export const nextVersion = (version: string) =>
  new Date(Math.max(Date.now(), new Date(version).getTime() + 1));
