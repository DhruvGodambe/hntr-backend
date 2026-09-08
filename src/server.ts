import { ENV, logVoucherEnvStatus } from './config/env';
import { connectDB } from './config/db';
import { logger } from './utils/logger';
import { installFetchLogger } from './utils/fetchLogger';
import { BlockchainService } from './services/blockchain.service';
import { verifyBurnerWallet } from './services/contract.service';
import { initCronJobs } from './jobs/leadership-cron';
import { createApp } from './app';

installFetchLogger();
logVoucherEnvStatus();

const app = createApp();

const startServer = async () => {
  try {
    if (ENV.NODE_ENV === 'production' && ENV.JWT_SECRET === 'dev-insecure-secret-change-me') {
      logger.error('JWT_SECRET is using the insecure default value in production. Set a strong JWT_SECRET env var.');
    }

    await connectDB();

    const blockchainService = new BlockchainService();
    blockchainService.startListening();
    logger.info('Blockchain Service Event Listener Started');

    // Non-fatal: logs loudly if the burner key is missing/mismatched/over-privileged.
    verifyBurnerWallet().catch((err) => logger.warn(`verifyBurnerWallet: ${err.message}`));

    initCronJobs();

    app.listen(ENV.PORT, () => {
      logger.info(`Server successfully started on port ${ENV.PORT}`);
    });
  } catch (error: any) {
    logger.error('Critical failure during server startup:', error);
    process.exit(1);
  }
};

startServer();
