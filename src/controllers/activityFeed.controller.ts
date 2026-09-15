import { Request, Response, NextFunction } from 'express';
import { ActivityFeedService } from '../services/activityFeed.service';
import { sendSuccess } from '../utils/response';

export class ActivityFeedController {
  static async getFeed(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
      const items = await ActivityFeedService.getPublicFeed(limit);
      sendSuccess(res, items);
    } catch (error) {
      next(error);
    }
  }
}
