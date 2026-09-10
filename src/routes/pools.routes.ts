import { Router } from 'express';
import { PoolsController } from '../controllers/pools.controller';
import { marketApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

// Public, read-only view of admin-managed strategy pools. Same rate limiter as
// the other market/read endpoints; no auth.
router.use(marketApiRateLimit);

router.get('/', PoolsController.list);
router.get('/:slug', PoolsController.getBySlug);
router.post('/:slug/offer-payload', PoolsController.offerPayload);

export default router;
