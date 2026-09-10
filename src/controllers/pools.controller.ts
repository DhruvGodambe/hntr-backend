import { Request, Response, NextFunction } from 'express';
import { StrategyPoolService, PoolServiceError } from '../services/strategyPool.service';
import { sendSuccess, sendError } from '../utils/response';

function handlePoolError(err: unknown, res: Response, next: NextFunction) {
  if (err instanceof PoolServiceError) {
    sendError(res, err.message, err.statusCode, { code: err.code });
    return;
  }
  next(err);
}

export class PoolsController {
  static async list(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await StrategyPoolService.getPublicPools();
      sendSuccess(res, data, 'Strategy pools retrieved successfully');
    } catch (error) {
      handlePoolError(error, res, next);
    }
  }

  static async getBySlug(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const slug = String(req.params.slug || '').trim();
      const data = await StrategyPoolService.getPublicPoolBySlug(slug);
      sendSuccess(res, data, 'Strategy pool retrieved successfully');
    } catch (error) {
      handlePoolError(error, res, next);
    }
  }

  static async offerPayload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const slug = String(req.params.slug || '').trim();
      const { offerer, quantity } = req.body || {};
      const data = await StrategyPoolService.buildOfferPayload(
        slug,
        typeof offerer === 'string' ? offerer.trim() : '',
        quantity === undefined ? 1 : Number(quantity),
      );
      sendSuccess(res, data, 'OpenSea offer payload assembled');
    } catch (error) {
      handlePoolError(error, res, next);
    }
  }
}
