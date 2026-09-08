import { Router } from 'express';
import { VoucherController } from '../controllers/voucher.controller';
import { requireWalletAuth } from '../middlewares/auth.middleware';
import {
  userApiRateLimit,
  voucherIssueRateLimit,
  voucherRedeemRateLimit,
  voucherRevealRateLimit,
} from '../middlewares/rateLimiter.middleware';

const router = Router();

// Every route is wallet-authenticated: a body walletAddress is never trusted, and
// the redeemer must resolve to a real User for the tier to attach to the network.
router.use(requireWalletAuth);

router.get('/access', userApiRateLimit, VoucherController.getAccess);
router.get('/', userApiRateLimit, VoucherController.listMine);
router.post('/', voucherIssueRateLimit, VoucherController.issue);
router.get('/:voucherId/code', voucherRevealRateLimit, VoucherController.revealCode);
router.post('/:voucherId/share', userApiRateLimit, VoucherController.share);
router.post('/:voucherId/revoke', userApiRateLimit, VoucherController.revoke);
router.post('/redeem', voucherRedeemRateLimit, VoucherController.redeem);

export default router;
