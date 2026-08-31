import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { requireWalletAuth, requireSelfWallet, requireSelfUsername } from '../middlewares/auth.middleware';
import { userApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

router.get('/sponsor/:username/validate', UserController.validateSponsor);
router.post('/register', UserController.register);

router.get(
  '/wallet/:walletAddress',
  userApiRateLimit,
  requireWalletAuth,
  requireSelfWallet('walletAddress'),
  UserController.getProfileByWallet,
);

router.get(
  '/:username',
  userApiRateLimit,
  requireWalletAuth,
  requireSelfUsername('username'),
  UserController.getProfile,
);

export default router;
