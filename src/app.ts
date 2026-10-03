import express from 'express';
import router from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { securityMiddlewares, generalLimiter } from './middleware/security.js';
const app = express();
app.disable('x-powered-by');
app.use(securityMiddlewares);
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) =>
  res.json({
    success: true,
    message: 'API is running',
    timestamp: new Date().toISOString(),
  }),
);
app.use('/api/v1', generalLimiter, router);
app.use(notFoundHandler);
app.use(errorHandler);
export default app;
