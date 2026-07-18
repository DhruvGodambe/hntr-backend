import { Router } from 'express';
import { NetworkController } from '../controllers/network.controller';
import { requireWalletAuth } from '../middlewares/auth.middleware';

const router = Router();

router.get('/:username/uplines', NetworkController.getUplines);
router.get('/:username/downline', NetworkController.getDownline);
router.get('/:username/tree', NetworkController.getNetworkTree);

router.post('/claim', requireWalletAuth, NetworkController.claimCommissions);
router.get('/transactions/:walletAddress', NetworkController.getTransactions);
router.get('/:walletAddress/rewards-summary', NetworkController.getRewardsSummary);
router.get('/:walletAddress/leadership-payouts', NetworkController.getLeadershipPayouts);
router.get('/:walletAddress/points', NetworkController.getPointsSummary);
router.post('/:walletAddress/points/recalculate', NetworkController.recalculatePoints);

export default router;
