import { Request, Response, NextFunction } from 'express';
import { CoinGeckoService } from '../services/coingecko.service';
import { OpenSeaService } from '../services/opensea.service';
import { sendSuccess, sendError } from '../utils/response';

function pathFromQuery(req: Request): string | null {
  const path = req.query.path;
  if (typeof path !== 'string' || !path.trim()) return null;
  return path;
}

export class MarketController {
  static async getCoinGecko(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const path = pathFromQuery(req);
      if (!path) {
        res.status(400).json({ error: 'Missing path query parameter' });
        return;
      }

      const result = await CoinGeckoService.get(path);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  }

  static async getEthUsd(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await CoinGeckoService.getEthUsdPrice();
      if (result.status !== 200) {
        const body = result.body as { error?: string } | null;
        sendError(res, body?.error || 'Failed to fetch ETH/USD', result.status);
        return;
      }
      sendSuccess(res, result.body, 'ETH/USD price');
    } catch (error) {
      next(error);
    }
  }

  static async getOpenSea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const path = pathFromQuery(req);
      if (!path) {
        res.status(400).json({ error: 'Missing path query parameter' });
        return;
      }

      const result = await OpenSeaService.proxy('GET', path);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  }

  static async postOpenSea(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const path = pathFromQuery(req);
      if (!path) {
        res.status(400).json({ error: 'Missing path query parameter' });
        return;
      }

      const body =
        req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0
          ? JSON.stringify(req.body)
          : undefined;

      const result = await OpenSeaService.proxy('POST', path, body);
      res.status(result.status).json(result.body);
    } catch (error) {
      next(error);
    }
  }
}
