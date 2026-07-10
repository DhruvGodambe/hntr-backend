import express from 'express';
import cors from 'cors';
import { ENV } from './config/env';
import { connectDB } from './config/db';
import { logger } from './utils/logger';
import { errorHandler } from './middlewares/errorHandler';

import userRoutes from './routes/users.routes';
import networkRoutes from './routes/network.routes';
import adminRoutes from './routes/admin.routes';
import { BlockchainService } from './services/blockchain.service';
import { initCronJobs } from './jobs/leadership-cron';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use('/api/users', userRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/admin', adminRoutes);

// Healthcheck
app.get('/health', (req, res) => {
    res.json({ status: 'ok', environment: ENV.NODE_ENV });
});

// Global Error Handler
app.use(errorHandler);

const startServer = async () => {
    try {
        await connectDB();
        
        // Start blockchain listener
        const blockchainService = new BlockchainService();
        blockchainService.startListening();
        logger.info('Blockchain Service Event Listener Started');

        // Start background cron jobs
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
