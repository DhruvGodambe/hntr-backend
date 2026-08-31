import { Router } from 'express';
import { NetworkController } from '../controllers/network.controller';
import { requireWalletAuth, requireSelfWallet, requireSelfUsername } from '../middlewares/auth.middleware';
import { userApiRateLimit } from '../middlewares/rateLimiter.middleware';

const router = Router();

const ownWallet = [userApiRateLimit, requireWalletAuth, requireSelfWallet('walletAddress')] as const;
const ownUsername = [userApiRateLimit, requireWalletAuth, requireSelfUsername('username')] as const;

router.get('/:username/uplines', ...ownUsername, NetworkController.getUplines);
router.get('/:username/downline', ...ownUsername, NetworkController.getDownline);
router.get('/:username/tree', ...ownUsername, NetworkController.getNetworkTree);

router.post('/claim', requireWalletAuth, NetworkController.claimCommissions);
router.post('/relay/fail', requireWalletAuth, NetworkController.failPendingRelay);
router.post('/relay/submit', requireWalletAuth, NetworkController.submitPendingRelay);

router.get('/transactions/:walletAddress', ...ownWallet, NetworkController.getTransactions);
router.get('/:walletAddress/rewards-summary', ...ownWallet, NetworkController.getRewardsSummary);
router.get('/:walletAddress/leadership-payouts', ...ownWallet, NetworkController.getLeadershipPayouts);
router.get('/:walletAddress/leadership-status', ...ownWallet, NetworkController.getLeadershipStatus);
router.get('/:walletAddress/achievement-status', ...ownWallet, NetworkController.getAchievementStatus);
router.get('/:walletAddress/notifications', ...ownWallet, NetworkController.getNotifications);
router.post('/:walletAddress/notifications/read', ...ownWallet, NetworkController.markNotificationsRead);
router.get('/:walletAddress/points', ...ownWallet, NetworkController.getPointsSummary);
router.post('/:walletAddress/points/recalculate', ...ownWallet, NetworkController.recalculatePoints);

export default router;
