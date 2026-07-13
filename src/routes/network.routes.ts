import { Router } from 'express';
import { NetworkController } from '../controllers/network.controller';

const router = Router();

router.get('/:username/uplines', NetworkController.getUplines);
router.get('/:username/downline', NetworkController.getDownline);

router.post('/claim', NetworkController.claimCommissions);
router.get('/transactions/:walletAddress', NetworkController.getTransactions);

export default router;
