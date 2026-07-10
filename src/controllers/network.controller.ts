import { Request, Response, NextFunction } from 'express';
import { NetworkService } from '../services/network.service';
import { sendSuccess } from '../utils/response';

export class NetworkController {
  static async getUplines(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const uplines = await NetworkService.getUplines(username as string);
      sendSuccess(res, { uplines }, 'Uplines retrieved successfully');
    } catch (error) {
      next(error);
    }
  }

  static async getDownline(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username } = req.params;
      const downlines = await NetworkService.getDownline(username as string);
      sendSuccess(res, { downlines }, 'Downline retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
}
