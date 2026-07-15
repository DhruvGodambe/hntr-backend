import { Router } from 'express';
import { MembershipController } from '../controllers/membership.controller';
import { requireWalletAuth } from '../middlewares/auth.middleware';

const router = Router();

router.use(requireWalletAuth);

router.get('/quote', MembershipController.quote);
router.post('/purchase', MembershipController.purchase);
router.post('/upgrade', MembershipController.upgrade);

export default router;
