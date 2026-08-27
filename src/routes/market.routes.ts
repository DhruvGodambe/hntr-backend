import { Router } from 'express';
import { MarketController } from '../controllers/market.controller';
import { marketApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

router.use(marketApiRateLimit);

router.get('/coingecko', MarketController.getCoinGecko);
router.get('/opensea', MarketController.getOpenSea);
router.post('/opensea', MarketController.postOpenSea);

export default router;
