import { closeEmailQueue } from './emails/queue.js';
import { logger } from './utils/logger.js';
import app from './app.js';
import { config } from './config/env.js';
import { checkDatabase, disconnectDatabase } from './config/database.js';
await checkDatabase();
const server = app.listen(config.PORT, '0.0.0.0', () =>
  logger.info(`iMet API listening on port ${config.PORT}`),
);
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(async () => {
    await closeEmailQueue();
    await disconnectDatabase();
    clearTimeout(timeout);
    process.exit(0);
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
