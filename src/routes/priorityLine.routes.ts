import { Router } from 'express';
import { PriorityLineController } from '../controllers/priorityLine.controller';
import { requireWalletAuth } from '../middlewares/auth.middleware';
import { userApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

// Wallet-authenticated: the member is always req.walletAddress, never a body field.
router.use(requireWalletAuth);

router.get('/me', userApiRateLimit, PriorityLineController.getOverview);
router.post('/deposit/prepare', userApiRateLimit, PriorityLineController.prepareDeposit);
router.post('/deposit/confirm', userApiRateLimit, PriorityLineController.confirmDeposit);
router.post('/withdrawals', userApiRateLimit, PriorityLineController.requestWithdrawal);

export default router;
