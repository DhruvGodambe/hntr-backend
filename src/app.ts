import express, { Express } from 'express';
import cors from 'cors';
import { errorHandler } from './middlewares/errorHandler';
import { requestLogger } from './middlewares/requestLogger.middleware';

import userRoutes from './routes/users.routes';
import networkRoutes from './routes/network.routes';
import adminRoutes from './routes/admin.routes';
import adminPanelRoutes from './routes/adminPanel.routes';
import authRoutes from './routes/auth.routes';
import membershipRoutes from './routes/membership.routes';
import voucherRoutes from './routes/voucher.routes';
import marketRoutes from './routes/market.routes';
import poolsRoutes from './routes/pools.routes';

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);

  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/network', networkRoutes);
  app.use('/api/membership', membershipRoutes);
  app.use('/api/vouchers', voucherRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/pools', poolsRoutes);
  app.use('/api/admin', adminPanelRoutes);
  app.use('/api/admin', adminRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
  });

  app.use(errorHandler);
  return app;
}
