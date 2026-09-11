import { Router } from 'express';
import { UserController } from '../controllers/user.controller';
import { requireWalletAuth, requireSelfWallet, requireSelfUsername } from '../middlewares/auth.middleware';
import { userApiRateLimit, publicUserLookupRateLimit } from '../middlewares/rateLimiter.middleware';
import { verifyTurnstile } from '../middlewares/turnstile.middleware';

const router = Router();

router.get('/sponsor/:username/validate', UserController.validateSponsor);
router.get('/username/:username/available', publicUserLookupRateLimit, UserController.checkUsername);
router.post('/register', verifyTurnstile, UserController.register);

router.get(
  '/wallet/:walletAddress',
  userApiRateLimit,
  requireWalletAuth,
  requireSelfWallet('walletAddress'),
  UserController.getProfileByWallet,
);

router.patch(
  '/wallet/:walletAddress/full-name',
  userApiRateLimit,
  requireWalletAuth,
  requireSelfWallet('walletAddress'),
  UserController.updateFullName,
);

/** Authenticated username typeahead (gift-code share, etc.). Must be before /:username. */
router.get('/search', userApiRateLimit, requireWalletAuth, UserController.searchUsernames);

router.get(
  '/:username',
  userApiRateLimit,
  requireWalletAuth,
  requireSelfUsername('username'),
  UserController.getProfile,
);

export default router;
