import { Router } from 'express';
import { ActivityFeedController } from '../controllers/activityFeed.controller';
import { marketApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

/** Public: homepage "platform activity" rail (recent signups + purchases). */
router.get('/feed', marketApiRateLimit, ActivityFeedController.getFeed);

export default router;
