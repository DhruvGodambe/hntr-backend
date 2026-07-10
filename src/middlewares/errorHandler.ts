import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { sendError } from '../utils/response';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error(`[Error] ${req.method} ${req.url} - ${err.message}`, err.stack);
    
    // Default to 500 server error
    const statusCode = res.statusCode !== 200 ? res.statusCode : 500;
    
    sendError(res, err.message, statusCode, process.env.NODE_ENV === 'development' ? err.stack : null);
};
